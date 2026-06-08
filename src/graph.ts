import { readFileSync, existsSync } from 'node:fs'
import { dirname, normalize, join, extname } from 'node:path'
import type { Root, Link } from 'mdast'
import type { FileNode } from './types.js'
import { parseMarkdown, extractTitle } from './markdown.js'

interface FileEntry {
  relativePath: string
  absolutePath: string
  title: string
  outLinks: string[] // relative paths of .md files this file links to
}

// Resolves a markdown href to a relative path from the docs root, or null.
function resolveHref(sourceRelativePath: string, href: string, docPath: string): string | null {
  if (href.startsWith('http') || href.startsWith('#') || !href) return null
  const hrefNoAnchor = href.split('#')[0]
  if (!hrefNoAnchor || extname(hrefNoAnchor) !== '.md') return null

  const sourceDir = dirname(sourceRelativePath)
  const resolved = normalize(join(sourceDir, hrefNoAnchor)).replace(/\\/g, '/')

  // Reject links that escape the docs folder
  if (resolved.startsWith('..')) return null

  const absoluteTarget = join(docPath, resolved)
  if (!existsSync(absoluteTarget)) {
    console.warn(`  warn: broken link in ${sourceRelativePath} → ${resolved}`)
    return null
  }

  return resolved
}

// Collects all internal .md links from a parsed AST.
function collectLinks(ast: Root, sourceRelativePath: string, docPath: string): string[] {
  const links: string[] = []

  function walk(node: any) {
    if (node.type === 'link') {
      const resolved = resolveHref(sourceRelativePath, (node as Link).url, docPath)
      if (resolved) links.push(resolved)
    }
    if (node.children) node.children.forEach(walk)
  }

  ast.children.forEach(walk)
  return links
}

// Scans all .md files and builds a map of relativePath → FileEntry.
function scanFiles(docPath: string, nodes: FileNode[]): Map<string, FileEntry> {
  const map = new Map<string, FileEntry>()

  function walk(nodes: FileNode[]) {
    for (const node of nodes) {
      if (node.type === 'file') {
        const content = readFileSync(node.absolutePath, 'utf-8')
        const ast = parseMarkdown(content)
        const title = extractTitle(ast) ?? node.name
        const outLinks = collectLinks(ast, node.relativePath, docPath)
        map.set(node.relativePath, {
          relativePath: node.relativePath,
          absolutePath: node.absolutePath,
          title,
          outLinks,
        })
      }
      if (node.children.length > 0) walk(node.children)
    }
  }

  walk(nodes)
  return map
}

// Builds a FileNode tree from the link graph.
// Rules:
//   - Root candidates: files named index.md with no incoming links, or files with most outgoing links
//   - A file becomes a child of the first file that links to it (first-parent wins)
//   - Circular links: if a target is already placed in the tree, it stays where it is (no re-parenting)
//   - Orphans (no incoming links, not a root): appended at top level
export function buildGraphTree(docPath: string, flatNodes: FileNode[]): FileNode[] {
  const entries = scanFiles(docPath, flatNodes)
  const allPaths = [...entries.keys()]

  // Count incoming links for each file
  const incomingCount = new Map<string, number>()
  for (const path of allPaths) incomingCount.set(path, 0)
  for (const entry of entries.values()) {
    for (const link of entry.outLinks) {
      incomingCount.set(link, (incomingCount.get(link) ?? 0) + 1)
    }
  }

  // Find root candidates: files with zero incoming links, sorted by outgoing links desc then alpha
  const roots = allPaths
    .filter((p) => (incomingCount.get(p) ?? 0) === 0)
    .sort((a, b) => {
      const diff = (entries.get(b)!.outLinks.length) - (entries.get(a)!.outLinks.length)
      return diff !== 0 ? diff : a.localeCompare(b)
    })

  // Build tree: DFS from each root, first-parent wins
  const placed = new Set<string>()

  function buildNode(relativePath: string): FileNode {
    placed.add(relativePath)
    const entry = entries.get(relativePath)!

    const children: FileNode[] = []
    for (const childPath of entry.outLinks) {
      if (placed.has(childPath)) continue // already placed elsewhere — will become a mention
      if (!entries.has(childPath)) continue
      children.push(buildNode(childPath))
    }

    return {
      name: entry.title,
      absolutePath: entry.absolutePath,
      relativePath: entry.relativePath,
      type: 'file',
      children,
    }
  }

  const tree: FileNode[] = []
  for (const root of roots) {
    if (!placed.has(root)) tree.push(buildNode(root))
  }

  // Orphans that were never reached (isolated files with no links at all)
  for (const path of allPaths) {
    if (!placed.has(path)) {
      console.warn(`  warn: orphan file placed at root — ${path}`)
      tree.push(buildNode(path))
    }
  }

  return tree
}
