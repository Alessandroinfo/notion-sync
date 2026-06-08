import { resolve } from 'node:path'
import { createClient } from './notion.js'
import { loadCache, saveCache } from './cache.js'
import { sync } from './sync.js'

function getConfig() {
  const docPath = process.argv[2] ?? process.env.NOTION_DOC_PATH
  const apiKey = process.env.NOTION_API_KEY
  const rootPageId = process.env.NOTION_PAGE_ID

  const errors: string[] = []
  if (!docPath) errors.push('Percorso docs mancante (primo argomento CLI o NOTION_DOC_PATH)')
  if (!apiKey) errors.push('NOTION_API_KEY non impostata')

  if (errors.length) {
    console.error('\nErrore di configurazione:')
    errors.forEach((e) => console.error(`  - ${e}`))
    console.error('\nUso:')
    console.error('  NOTION_API_KEY=xxx [NOTION_PAGE_ID=yyy] npx tsx src/index.ts <path>')
    console.error('\n  NOTION_PAGE_ID è opzionale: se omesso le pagine vengono create nella root del workspace.')
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
    console.log('\nSync completata.')
  } catch (err) {
    saveCache(config.docPath, cache)
    console.error('\nErrore durante la sync:', err)
    process.exit(1)
  }
}

main()
