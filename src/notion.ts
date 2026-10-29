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

export async function appendBlocks(
  client: Client,
  pageId: string,
  blocks: BlockObjectRequest[]
): Promise<void> {
  for (let i = 0; i < blocks.length; i += CHUNK_SIZE) {
    const chunk = blocks.slice(i, i + CHUNK_SIZE)
    await client.blocks.children.append({ block_id: pageId, children: chunk as any })
  }
}
