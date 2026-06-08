export interface SyncConfig {
  docPath: string
  apiKey: string
  rootPageId: string | null // null = workspace root
}

export interface Cache {
  version: 1
  rootPageId: string | null
  pages: Record<string, string> // relativePath → notionPageId
}

export interface FileNode {
  name: string
  absolutePath: string
  relativePath: string // relative to docPath, uses /
  type: 'file' | 'dir'
  children: FileNode[]
}
