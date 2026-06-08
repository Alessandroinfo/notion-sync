import { readdirSync, statSync } from 'node:fs'
import { join, relative, extname, basename } from 'node:path'
import type { FileNode } from './types.js'

export function buildTree(docPath: string, currentPath: string = docPath): FileNode[] {
  const entries = readdirSync(currentPath).sort()
  const nodes: FileNode[] = []

  for (const entry of entries) {
    if (entry.startsWith('.')) continue

    const absolutePath = join(currentPath, entry)
    const stat = statSync(absolutePath)
    const relativePath = relative(docPath, absolutePath).replace(/\\/g, '/')

    if (stat.isDirectory()) {
      nodes.push({
        name: entry,
        absolutePath,
        relativePath,
        type: 'dir',
        children: buildTree(docPath, absolutePath),
      })
    } else if (extname(entry) === '.md') {
      nodes.push({
        name: basename(entry, '.md'),
        absolutePath,
        relativePath,
        type: 'file',
        children: [],
      })
    }
  }

  return nodes
}
