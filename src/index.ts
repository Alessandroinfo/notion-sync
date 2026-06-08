import { resolve } from 'node:path'
import { createClient } from './notion.js'
import { loadCache, saveCache } from './cache.js'
import { sync } from './sync.js'

function getConfig() {
  const docPath = process.argv[2] ?? process.env.NOTION_DOC_PATH
  const apiKey = process.env.NOTION_API_KEY
  const rootPageId = process.env.NOTION_PAGE_ID

  const errors: string[] = []
  if (!docPath) errors.push('Docs path missing (first CLI argument or NOTION_DOC_PATH env var)')
  if (!apiKey) errors.push('NOTION_API_KEY is not set')

  if (errors.length) {
    console.error('\nConfiguration error:')
    errors.forEach((e) => console.error(`  - ${e}`))
    console.error('\nUsage:')
    console.error('  NOTION_API_KEY=xxx [NOTION_PAGE_ID=yyy] npx tsx src/index.ts <path>')
    console.error('\n  NOTION_PAGE_ID is optional: if omitted, pages are created at the workspace root.')
    process.exit(1)
  }

  return {
    docPath: resolve(docPath!),
    apiKey: apiKey!,
    rootPageId: rootPageId ?? null,
  }
}

async function main() {
  const config = getConfig()
  const client = createClient(config.apiKey)
  const cache = loadCache(config.docPath, config.rootPageId)

  console.log(`Root Notion page: ${config.rootPageId ?? 'workspace root'}`)
  console.log(`Doc path: ${config.docPath}`)

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
