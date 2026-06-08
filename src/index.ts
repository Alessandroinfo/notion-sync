import { resolve } from 'node:path'
import { createClient } from './notion.js'
import { loadCache, saveCache } from './cache.js'
import { sync } from './sync.js'
import type { SyncMode } from './types.js'

function getConfig() {
  // Accept: npx tsx src/index.ts [--mode mirror|graph] <path>
  const args = process.argv.slice(2)
  let mode: SyncMode = 'mirror'
  let docPathArg: string | undefined

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode' && args[i + 1]) {
      const m = args[++i]
      if (m !== 'mirror' && m !== 'graph') {
        console.error(`Invalid mode "${m}". Must be "mirror" or "graph".`)
        process.exit(1)
      }
      mode = m
    } else {
      docPathArg = args[i]
    }
  }

  // Env vars override CLI for CI/CD usage
  if (process.env.NOTION_SYNC_MODE) {
    const m = process.env.NOTION_SYNC_MODE
    if (m !== 'mirror' && m !== 'graph') {
      console.error(`Invalid NOTION_SYNC_MODE "${m}". Must be "mirror" or "graph".`)
      process.exit(1)
    }
    mode = m
  }

  const docPath = docPathArg ?? process.env.NOTION_DOC_PATH
  const apiKey = process.env.NOTION_API_KEY
  const rootPageId = process.env.NOTION_PAGE_ID

  const errors: string[] = []
  if (!docPath) errors.push('Docs path missing (CLI argument or NOTION_DOC_PATH env var)')
  if (!apiKey) errors.push('NOTION_API_KEY is not set')

  if (errors.length) {
    console.error('\nConfiguration error:')
    errors.forEach((e) => console.error(`  - ${e}`))
    console.error('\nUsage:')
    console.error('  NOTION_API_KEY=xxx [NOTION_PAGE_ID=yyy] [NOTION_SYNC_MODE=mirror|graph]')
    console.error('  npx tsx src/index.ts [--mode mirror|graph] <path>')
    console.error('\n  Modes:')
    console.error('    mirror  Replicate the filesystem hierarchy as-is (default)')
    console.error('    graph   Build the hierarchy from internal links between pages')
    process.exit(1)
  }

  return {
    docPath: resolve(docPath!),
    apiKey: apiKey!,
    rootPageId: rootPageId ?? null,
    mode,
  }
}

async function main() {
  const config = getConfig()
  const client = createClient(config.apiKey)
  const cache = loadCache(config.docPath, config.rootPageId)

  console.log(`Root Notion page: ${config.rootPageId ?? 'workspace root'}`)
  console.log(`Doc path: ${config.docPath}`)
  console.log(`Mode: ${config.mode}`)

  try {
    await sync(client, config, cache)
    saveCache(config.docPath, cache)
    console.log('\nSync completed.')
  } catch (err) {
    saveCache(config.docPath, cache)
    console.error('\nSync failed:', err)
    process.exit(1)
  }
}

main()
