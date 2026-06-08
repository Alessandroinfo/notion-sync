import { readFileSync } from 'node:fs'
import { dirname, normalize, join } from 'node:path'
import type { Client } from '@notionhq/client'
import type { Cache, FileNode, SyncConfig } from './types.js'
import { buildTree } from './fs.js'
import { buildGraphTree } from './graph.js'
import { parseMarkdown, mdastToNotionBlocks, extractTitle } from './markdown.js'
import { createPage, deleteChildPages, appendBlocks } from './notion.js'

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
  mode: 'mirror' | 'graph'
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

      // graph: node.name is the H1 title — skip it to avoid duplication
      // mirror: title is the filename — keep the H1 in the page content
      const blocks = mdastToNotionBlocks(ast, resolveLink, { skipFirstH1: mode === 'graph' })
      if (blocks.length > 0) {
        console.log(`  [content] ${node.relativePath}`)
        await appendBlocks(client, pageId, blocks)
      }
    }

    if (node.children.length > 0) {
      await syncContent(client, node.children, cache, mode)
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
  await syncContent(client, tree, cache, config.mode)
}
