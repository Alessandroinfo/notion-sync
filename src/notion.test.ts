import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendBlocks } from './notion.js'

interface Node {
  block: any
  children: string[]
}

// In-memory stand-in for the Notion blocks API. It rejects requests the real
// API would reject (nesting, array size, element count) and records the tree.
function fakeClient() {
  const nodes = new Map<string, Node>([['root', { block: null, children: [] }]])
  let counter = 0
  let requests = 0

  const depthOf = (block: any): number => {
    const children = block[block.type]?.children ?? []
    return children.length ? 1 + Math.max(...children.map(depthOf)) : 0
  }
  const countOf = (block: any): number =>
    1 + (block[block.type]?.children ?? []).reduce((n: number, c: any) => n + countOf(c), 0)

  const create = (parentId: string, block: any): string => {
    const id = `b${++counter}`
    const { children = [], ...body } = block[block.type] ?? {}
    nodes.set(id, { block: { ...block, [block.type]: body }, children: [] })
    nodes.get(parentId)!.children.push(id)
    for (const child of children) create(id, child)
    return id
  }

  const client: any = {
    blocks: {
      children: {
        append: async ({ block_id, children }: { block_id: string; children: any[] }) => {
          requests++
          assert.ok(nodes.has(block_id), `unknown parent ${block_id}`)
          assert.ok(children.length <= 100, 'more than 100 blocks in a request')
          for (const block of children) {
            assert.ok(depthOf(block) <= 2, 'more than two levels of nesting')
            const walk = (b: any) => {
              const nested = b[b.type]?.children ?? []
              assert.ok(nested.length <= 100, 'more than 100 children in an array')
              nested.forEach(walk)
            }
            walk(block)
          }
          const total = children.reduce((n, b) => n + countOf(b), 0)
          assert.ok(total <= 1000, 'more than 1000 block elements in a request')
          return { results: children.map((block) => ({ id: create(block_id, block) })) }
        },
        list: async ({ block_id }: { block_id: string }) => {
          requests++
          return {
            results: nodes.get(block_id)!.children.map((id) => ({ id })),
            has_more: false,
            next_cursor: null,
          }
        },
      },
    },
  }

  // Rebuilds the stored tree in the request format, to compare with the input.
  const tree = (id = 'root'): any[] =>
    nodes.get(id)!.children.map((childId) => {
      const { block } = nodes.get(childId)!
      const children = tree(childId)
      return children.length ? { ...block, [block.type]: { ...block[block.type], children } } : block
    })

  return { client, tree, requests: () => requests }
}

const item = (label: string, children: any[] = []): any => ({
  type: 'bulleted_list_item',
  bulleted_list_item: {
    rich_text: [{ type: 'text', text: { content: label } }],
    ...(children.length ? { children } : {}),
  },
})

const row = (n: number): any => ({
  type: 'table_row',
  table_row: { cells: [[{ type: 'text', text: { content: String(n) } }]] },
})

test('shallow blocks are sent in a single request', async () => {
  const fake = fakeClient()
  const blocks = [item('a', [item('a1')]), item('b')]
  await appendBlocks(fake.client, 'root', blocks)
  assert.deepEqual(fake.tree(), blocks)
  assert.equal(fake.requests(), 1)
})

test('content deeper than the nesting limit is appended level by level', async () => {
  const fake = fakeClient()
  const blocks = [item('a', [item('b', [item('c', [item('d', [item('e')])])])])]
  await appendBlocks(fake.client, 'root', blocks)
  assert.deepEqual(fake.tree(), blocks)
})

test('tables nested in list items keep their rows', async () => {
  const fake = fakeClient()
  const table = { type: 'table', table: { table_width: 1, has_column_header: true, has_row_header: false, children: [row(1), row(2)] } }
  const blocks = [item('with table', [table])]
  await appendBlocks(fake.client, 'root', blocks)
  assert.deepEqual(fake.tree(), blocks)
})

test('more than 100 children or rows are split across requests in order', async () => {
  const fake = fakeClient()
  const rows = Array.from({ length: 230 }, (_, i) => row(i))
  const table = { type: 'table', table: { table_width: 1, has_column_header: true, has_row_header: false, children: rows } }
  const longList = item('long', Array.from({ length: 150 }, (_, i) => item(`n${i}`)))
  const blocks = [table, longList]
  await appendBlocks(fake.client, 'root', blocks)
  assert.deepEqual(fake.tree(), blocks)
})

test('large pages are split by block count and by element count', async () => {
  const fake = fakeClient()
  const many = Array.from({ length: 250 }, (_, i) => item(`top${i}`))
  const heavy = Array.from({ length: 12 }, (_, i) =>
    item(`heavy${i}`, Array.from({ length: 99 }, (_, j) => item(`${i}.${j}`)))
  )
  const blocks = [...many, ...heavy]
  await appendBlocks(fake.client, 'root', blocks)
  assert.deepEqual(fake.tree(), blocks)
})
