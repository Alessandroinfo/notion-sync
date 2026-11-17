import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { Client } from '@notionhq/client'
import type { BlockObjectRequest } from '@notionhq/client/build/src/api-endpoints.js'

const NOTION_VERSION = '2022-06-28'
const CHUNK_SIZE = 100 // Notion max blocks per request
const API_BASE = 'https://api.notion.com/v1'

// Image formats Notion accepts through the File Upload API.
const IMAGE_CONTENT_TYPES: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}

// A single-part upload accepts up to 20 MiB; free workspaces stop at 5 MiB
// and Notion rejects larger files with an error.
const SINGLE_PART_MAX_BYTES = 20 * 1024 * 1024
const MAX_ATTEMPTS = 3

export function createClient(apiKey: string): Client {
  return new Client({ auth: apiKey, notionVersion: NOTION_VERSION })
}

export async function createPage(
  client: Client,
  parentPageId: string | null,
  title: string
): Promise<string> {
  const response = await client.pages.create({
    parent: parentPageId
      ? { page_id: parentPageId }
      : ({ type: 'workspace', workspace: true } as any),
    properties: {
      title: { title: [{ type: 'text', text: { content: title } }] },
    },
  })
  return response.id
}

// Deletes all child_page blocks directly under a page (one level only).
export async function deleteChildPages(client: Client, pageId: string): Promise<void> {
  let cursor: string | undefined

  do {
    const response = await client.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100,
    })

    const childPages = response.results.filter((b) => (b as any).type === 'child_page')
    await Promise.all(childPages.map((block) => client.blocks.delete({ block_id: block.id })))

    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
  } while (cursor)
}

// Deletes the content blocks of a page, keeping its subpages.
export async function deleteChildBlocks(client: Client, pageId: string): Promise<void> {
  let cursor: string | undefined
  const contentBlocks: string[] = []

  do {
    const response = await client.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100,
    })
    for (const block of response.results) {
      if ((block as any).type !== 'child_page') contentBlocks.push(block.id)
    }
    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
  } while (cursor)

  for (const id of contentBlocks) await client.blocks.delete({ block_id: id })
}

export function imageContentType(path: string): string | null {
  return IMAGE_CONTENT_TYPES[extname(path).toLowerCase()] ?? null
}

// Uploads a local file (File Upload API, single part) and returns the upload
// ID to reference from an image block. An upload must be attached within one
// hour; once attached, the same ID can be attached again on other pages.
export async function uploadFile(
  apiKey: string,
  absolutePath: string,
  contentType: string
): Promise<string> {
  const data = readFileSync(absolutePath)
  if (data.byteLength > SINGLE_PART_MAX_BYTES) {
    throw new Error(`file larger than ${SINGLE_PART_MAX_BYTES / 1024 / 1024} MiB`)
  }
  const filename = basename(absolutePath)
  const headers = { Authorization: `Bearer ${apiKey}`, 'Notion-Version': NOTION_VERSION }

  const upload = await notionRequest(`${API_BASE}/file_uploads`, () => ({
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'single_part', filename, content_type: contentType }),
  }))

  await notionRequest(`${API_BASE}/file_uploads/${upload.id}/send`, () => {
    // fetch sets the multipart boundary when Content-Type is left out.
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(data)], { type: contentType }), filename)
    return { method: 'POST', headers, body: form }
  })

  return upload.id
}

// The upload endpoints are called with fetch (the client has no multipart
// support); rate-limited requests are retried after the delay Notion asks for.
async function notionRequest(url: string, init: () => RequestInit): Promise<{ id: string }> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, init())
    const body = await response.json().catch(() => ({}))
    if (response.ok) return body

    if (response.status === 429 && attempt < MAX_ATTEMPTS) {
      const seconds = Number(response.headers.get('retry-after')) || 1
      await new Promise((done) => setTimeout(done, seconds * 1000))
      continue
    }
    throw new Error(`${response.status} ${body.code ?? ''} ${body.message ?? ''}`.trim())
  }
}

// A single request accepts at most 1000 block elements, nested ones included.
const MAX_ELEMENTS_PER_REQUEST = 1000

function childrenOf(block: any): any[] {
  const body = block?.[block?.type]
  return Array.isArray(body?.children) ? body.children : []
}

function withChildren(block: any, children: any[]): any {
  const { children: _omitted, ...body } = block[block.type]
  return { ...block, [block.type]: children.length ? { ...body, children } : body }
}

function countElements(block: any): number {
  return 1 + childrenOf(block).reduce((sum, child) => sum + countElements(child), 0)
}

interface PreparedBlock {
  // What is sent now: the block with at most one level of children
  // (a table always keeps its rows, which are required at creation).
  block: any
  // Direct children beyond the 100-per-array limit, appended after the block.
  laterChildren: any[]
  // Grandchildren keyed by the index of the child they belong to, appended
  // under that child once it exists.
  laterGrandchildren: Map<number, any[]>
}

// Notion allows up to two levels of nesting per request; sending one level of
// children (plus table rows) always stays within it, whatever the depth of
// the Markdown. Deeper content is appended afterwards, level by level.
function prepareBlock(block: any): PreparedBlock {
  const children = childrenOf(block)
  const inline = children.slice(0, CHUNK_SIZE)
  const laterGrandchildren = new Map<number, any[]>()

  const shallow = inline.map((child, index) => {
    const grandchildren = childrenOf(child)
    if (grandchildren.length === 0) return child
    if (child.type === 'table') {
      // Rows of a nested table: the first 100 are sent with it, the rest later.
      if (grandchildren.length > CHUNK_SIZE) laterGrandchildren.set(index, grandchildren.slice(CHUNK_SIZE))
      return withChildren(child, grandchildren.slice(0, CHUNK_SIZE))
    }
    laterGrandchildren.set(index, grandchildren)
    return withChildren(child, [])
  })

  return {
    block: children.length ? withChildren(block, shallow) : block,
    laterChildren: children.slice(CHUNK_SIZE),
    laterGrandchildren,
  }
}

async function listChildIds(client: Client, blockId: string): Promise<string[]> {
  const ids: string[] = []
  let cursor: string | undefined
  do {
    const response = await client.blocks.children.list({ block_id: blockId, start_cursor: cursor, page_size: 100 })
    ids.push(...response.results.map((b) => b.id))
    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
  } while (cursor)
  return ids
}

// Appends blocks (and all their nested children) under a page or block,
// splitting the work into requests that respect Notion's limits.
export async function appendBlocks(
  client: Client,
  parentId: string,
  blocks: BlockObjectRequest[]
): Promise<void> {
  let next = 0
  while (next < blocks.length) {
    const batch: PreparedBlock[] = []
    let elements = 0
    while (next < blocks.length && batch.length < CHUNK_SIZE) {
      const prepared = prepareBlock(blocks[next])
      const size = countElements(prepared.block)
      if (batch.length > 0 && elements + size > MAX_ELEMENTS_PER_REQUEST) break
      batch.push(prepared)
      elements += size
      next++
    }

    const response = await client.blocks.children.append({
      block_id: parentId,
      children: batch.map((p) => p.block),
    })

    for (const [index, prepared] of batch.entries()) {
      if (prepared.laterGrandchildren.size === 0 && prepared.laterChildren.length === 0) continue
      const createdId = response.results[index].id
      if (prepared.laterGrandchildren.size > 0) {
        const childIds = await listChildIds(client, createdId)
        for (const [childIndex, grandchildren] of prepared.laterGrandchildren) {
          await appendBlocks(client, childIds[childIndex], grandchildren)
        }
      }
      if (prepared.laterChildren.length > 0) {
        await appendBlocks(client, createdId, prepared.laterChildren)
      }
    }
  }
}
