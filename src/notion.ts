import { Client } from '@notionhq/client'
import type { BlockObjectRequest } from '@notionhq/client/build/src/api-endpoints.js'

const NOTION_VERSION = '2022-06-28'
const CHUNK_SIZE = 100 // Notion max blocks per request

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

export async function clearPageContent(client: Client, pageId: string): Promise<void> {
  let cursor: string | undefined

  do {
    const response = await client.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100,
    })

    // Skip child_page blocks — they are subpages managed by the sync tree,
    // deleting them here would archive them and break the second pass.
    const deletable = response.results.filter((b) => (b as any).type !== 'child_page')
    await Promise.all(deletable.map((block) => client.blocks.delete({ block_id: block.id })))

    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
  } while (cursor)
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

export async function updatePageTitle(
  client: Client,
  pageId: string,
  title: string
): Promise<void> {
  await client.pages.update({
    page_id: pageId,
    properties: {
      title: { title: [{ type: 'text', text: { content: title } }] },
    },
  })
}
