import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Cache } from './types.js'

const CACHE_FILE = '.notion-sync-cache.json'

export function loadCache(docPath: string, rootPageId: string | null): Cache {
  const cachePath = join(docPath, CACHE_FILE)
  if (existsSync(cachePath)) {
    try {
      const raw = JSON.parse(readFileSync(cachePath, 'utf-8')) as Cache
      // Invalidate cache if root page changed
      if (raw.rootPageId === rootPageId) return raw
    } catch {
      // corrupt cache, start fresh
    }
  }
  return { version: 1, rootPageId, pages: {} }
}

export function saveCache(docPath: string, cache: Cache): void {
  const cachePath = join(docPath, CACHE_FILE)
  writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8')
}
