import { readFileSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import type { Client } from '@notionhq/client'
import type { Cache, FileNode, SyncConfig } from './types.js'
import { buildTree } from './fs.js'
import { parseMarkdown, mdastToNotionBlocks } from './markdown.js'
import { createPage, clearPageContent, appendBlocks, updatePageTitle } from './notion.js'

// Resolves a relative markdown link (href) from a source file to a target relative path
function resolveRelativePath(sourceRelativePath: string, href: string): string | null {
  if (href.startsWith('http') || href.startsWith('#')) return null

  // Strip anchor fragments
  const hrefNoAnchor = href.split('#')[0]
  if (!hrefNoAnchor) return null

  const sourceDir = dirname(sourceRelativePath)
  const resolved = resolve(join(sourceDir, hrefNoAnchor))
    .replace(/\\/g, '/')
    // normalize: remove leading slash from resolve output
    .replace(/^\//, '')

  // Remove .md extension to match cache keys
  return resolved.replace(/\.md$/, '.md')
}

async function syncNode(
  client: Client,
  node: FileNode,
  parentPageId: string | null,
  cache: Cache,
  docPath: string
): Promise<void> {
  const cacheKey = node.relativePath
  let pageId = cache.pages[cacheKey]

  const title = node.name

  if (!pageId) {
    console.log(`  [create] ${node.relativePath}`)
    pageId = await createPage(client, parentPageId, title)
    cache.pages[cacheKey] = pageId
  } else {
    console.log(`  [update] ${node.relativePath}`)
    await updatePageTitle(client, pageId, title)
    await clearPageContent(client, pageId)
  }

  if (node.type === 'file') {
    const content = readFileSync(node.absolutePath, 'utf-8')
    const ast = parseMarkdown(content)

    const resolveLink = (href: string): string | null => {
      const targetRelPath = resolveRelativePath(node.relativePath, href)
      if (!targetRelPath) return null
      return cache.pages[targetRelPath] ?? null
    }

    const blocks = mdastToNotionBlocks(ast, resolveLink)
    if (blocks.length > 0) {
      await appendBlocks(client, pageId, blocks)
    }
  }

  // Recurse into children (dirs and files inside dirs)
  for (const child of node.children) {
    await syncNode(client, child, pageId, cache, docPath)
  }
}

export async function sync(client: Client, config: SyncConfig, cache: Cache): Promise<void> {
  console.log(`\nScanning: ${config.docPath}`)
  const tree = buildTree(config.docPath)

  if (tree.length === 0) {
    console.log('No .md files found.')
    return
  }

  // First pass: ensure all pages exist so links can resolve correctly
  console.log('\nPass 1/2 — creating pages...')
  await ensureAllPages(client, tree, config.rootPageId, cache)

  // Second pass: sync content with resolved links
  console.log('\nPass 2/2 — syncing content...')
  for (const node of tree) {
    await syncNode(client, node, config.rootPageId, cache, config.docPath)
  }
}

async function ensureAllPages(
  client: Client,
  nodes: FileNode[],
  parentPageId: string | null,
  cache: Cache
): Promise<void> {
  for (const node of nodes) {
    const cacheKey = node.relativePath
    if (!cache.pages[cacheKey]) {
      const pageId = await createPage(client, parentPageId, node.name)
      cache.pages[cacheKey] = pageId
    }
    if (node.children.length > 0) {
      await ensureAllPages(client, node.children, cache.pages[cacheKey]!, cache)
    }
  }
}
