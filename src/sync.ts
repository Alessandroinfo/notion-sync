import { existsSync, readFileSync } from 'node:fs'
import { dirname, normalize, join, relative, resolve, isAbsolute } from 'node:path'
import type { Client } from '@notionhq/client'
import type { Cache, FileNode, SyncConfig } from './types.js'
import { buildTree } from './fs.js'
import { buildGraphTree } from './graph.js'
import {
  parseMarkdown,
  mdastToNotionBlocks,
  extractTitle,
  collectLocalImages,
  withoutUploadedImages,
} from './markdown.js'
import {
  createPage,
  deleteChildPages,
  deleteChildBlocks,
  appendBlocks,
  imageContentType,
  uploadFile,
} from './notion.js'

// Uploads each local image once per run: absolute path → upload ID, or null
// when the file cannot be uploaded (the page then shows a text placeholder).
type ImageUploader = (absolutePath: string) => Promise<string | null>

function createImageUploader(apiKey: string): ImageUploader {
  const uploads = new Map<string, Promise<string | null>>()
  return (absolutePath) => {
    let upload = uploads.get(absolutePath)
    if (!upload) {
      upload = (async () => {
        const contentType = imageContentType(absolutePath)
        if (!contentType) {
          console.warn(`  [image] skipped, unsupported format: ${absolutePath}`)
          return null
        }
        try {
          const id = await uploadFile(apiKey, absolutePath, contentType)
          console.log(`  [image] uploaded ${absolutePath}`)
          return id
        } catch (err) {
          console.warn(`  [image] upload failed, kept as text: ${absolutePath} (${(err as Error).message})`)
          return null
        }
      })()
      uploads.set(absolutePath, upload)
    }
    return upload
  }
}

// Uploads the local images of one page and returns raw url → upload ID.
// Images outside the docs folder are ignored, like links that leave it.
async function uploadPageImages(
  urls: string[],
  sourceFile: string,
  docPath: string,
  uploadImage: ImageUploader
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>()
  for (const url of urls) {
    let path: string
    try {
      path = decodeURI(url.split(/[?#]/)[0])
    } catch {
      continue
    }
    const absolutePath = resolve(dirname(sourceFile), path)
    const fromRoot = relative(docPath, absolutePath)
    if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
      console.warn(`  [image] skipped, outside the docs folder: ${url}`)
      continue
    }
    if (!existsSync(absolutePath)) {
      console.warn(`  [image] skipped, file not found: ${url}`)
      continue
    }
    const id = await uploadImage(absolutePath)
    if (id) resolved.set(url, id)
  }
  return resolved
}

// Resolves a relative markdown link to a relative path from the docs root.
function resolveRelativePath(sourceRelativePath: string, href: string): string | null {
  if (href.startsWith('http') || href.startsWith('#')) return null
  const hrefNoAnchor = href.split('#')[0]
  if (!hrefNoAnchor) return null
  const sourceDir = dirname(sourceRelativePath)
  return normalize(join(sourceDir, hrefNoAnchor)).replace(/\\/g, '/')
}

function getTitleForNode(node: FileNode, mode: 'mirror' | 'graph'): string {
  // mirror: use the filename as-is (node.name is already the basename without .md)
  // graph:  node.name is set by buildGraphTree from the first H1
  if (mode === 'mirror') return node.name
  return node.name
}

// Pass 1: create all pages and populate the cache (relativePath → page ID).
async function createAllPages(
  client: Client,
  nodes: FileNode[],
  parentPageId: string | null,
  cache: Cache,
  mode: 'mirror' | 'graph'
): Promise<void> {
  for (const node of nodes) {
    const title = getTitleForNode(node, mode)
    const pageId = await createPage(client, parentPageId, title)
    cache.pages[node.relativePath] = pageId
    console.log(`  [create] ${node.relativePath}`)

    if (node.children.length > 0) {
      await createAllPages(client, node.children, pageId, cache, mode)
    }
  }
}

// Pass 2: append content to each file page with resolved internal links.
async function syncContent(
  client: Client,
  nodes: FileNode[],
  cache: Cache,
  mode: 'mirror' | 'graph',
  docPath: string,
  uploadImage: ImageUploader
): Promise<void> {
  for (const node of nodes) {
    if (node.type === 'file') {
      const pageId = cache.pages[node.relativePath]!
      const content = readFileSync(node.absolutePath, 'utf-8')
      const ast = parseMarkdown(content)

      const resolveLink = (href: string): string | null => {
        const targetRelPath = resolveRelativePath(node.relativePath, href)
        if (!targetRelPath) return null
        return cache.pages[targetRelPath] ?? null
      }

      // Uploaded right before the page content: an upload must be attached
      // within one hour.
      const images = await uploadPageImages(collectLocalImages(ast), node.absolutePath, docPath, uploadImage)

      // graph: node.name is the H1 title — skip it to avoid duplication
      // mirror: title is the filename — keep the H1 in the page content
      const blocks = mdastToNotionBlocks(ast, resolveLink, {
        skipFirstH1: mode === 'graph',
        resolveImage: (url) => images.get(url) ?? null,
      })
      if (blocks.length > 0) {
        console.log(`  [content] ${node.relativePath}`)
        try {
          await appendBlocks(client, pageId, blocks)
        } catch (err) {
          if (images.size === 0) throw err
          // An image Notion refuses must not lose the page: the retry starts
          // from scratch, so blocks already appended are removed first.
          console.warn(`  [image] page refused with images, kept as text: ${node.relativePath} (${(err as Error).message})`)
          await deleteChildBlocks(client, pageId)
          await appendBlocks(client, pageId, withoutUploadedImages(blocks))
        }
      }
    }

    if (node.children.length > 0) {
      await syncContent(client, node.children, cache, mode, docPath, uploadImage)
    }
  }
}

export async function sync(client: Client, config: SyncConfig, cache: Cache): Promise<void> {
  console.log(`\nScanning: ${config.docPath}`)
  console.log(`Mode: ${config.mode}`)

  const flatTree = buildTree(config.docPath)

  if (flatTree.length === 0) {
    console.log('No .md files found.')
    return
  }

  const tree = config.mode === 'graph'
    ? buildGraphTree(config.docPath, flatTree)
    : flatTree

  // Remove all previously synced pages from the root before recreating.
  if (config.rootPageId) {
    console.log('\nPass 1/3 — removing existing pages...')
    await deleteChildPages(client, config.rootPageId)
  }
  cache.pages = {}

  console.log('\nPass 2/3 — creating pages...')
  await createAllPages(client, tree, config.rootPageId, cache, config.mode)

  console.log('\nPass 3/3 — syncing content...')
  await syncContent(client, tree, cache, config.mode, config.docPath, createImageUploader(config.apiKey))
}
