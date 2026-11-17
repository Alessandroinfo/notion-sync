import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMarkdown, mdastToNotionBlocks, collectLocalImages, withoutUploadedImages } from './markdown.js'

const noLink = () => null

function convert(md: string, resolveLink: (href: string) => string | null = noLink): any[] {
  return mdastToNotionBlocks(parseMarkdown(md), resolveLink) as any[]
}

const text = (richText: any[]) => richText.map((p) => p.text.content).join('')

test('bold text containing inline code keeps the code', () => {
  const [p] = convert('**`client.ts`** — fetch')
  const parts = p.paragraph.rich_text
  assert.equal(text(parts), 'client.ts — fetch')
  assert.deepEqual(parts[0].annotations, { bold: true, code: true })
  assert.equal(parts[1].annotations, undefined)
})

test('mixed bold text and code keep their order and annotations', () => {
  const [p] = convert('**Nota su `TextSection`:** il campo')
  const parts = p.paragraph.rich_text
  assert.equal(text(parts), 'Nota su TextSection: il campo')
  assert.deepEqual(parts[1].annotations, { bold: true, code: true })
  assert.deepEqual(parts[2].annotations, { bold: true })
})

test('links inside bold and formatting inside links are preserved', () => {
  const [p] = convert('**[docs](https://example.com)** and [the *guide* `x`](https://example.com/g)')
  const parts = p.paragraph.rich_text
  assert.equal(text(parts), 'docs and the guide x')
  assert.deepEqual(parts[0], {
    type: 'text',
    text: { content: 'docs', link: { url: 'https://example.com' } },
    annotations: { bold: true },
  })
  const italic = parts.find((x: any) => x.text.content === 'guide')
  assert.deepEqual(italic.annotations, { italic: true })
  assert.equal(italic.text.link.url, 'https://example.com/g')
  const code = parts.find((x: any) => x.text.content === 'x')
  assert.deepEqual(code.annotations, { code: true })
})

test('internal .md links resolve to the Notion page and keep their label', () => {
  const [p] = convert('See [**deploy**](./deploy.md#secrets)', (href) =>
    href.startsWith('./deploy.md') ? 'aaaa-bbbb' : null
  )
  const link = p.paragraph.rich_text[1]
  assert.equal(link.text.content, 'deploy')
  assert.equal(link.text.link.url, 'https://www.notion.so/aaaabbbb')
  assert.deepEqual(link.annotations, { bold: true })
})

test('relative links that cannot be resolved stay plain text', () => {
  const [p] = convert('[guide](./missing.md)')
  assert.deepEqual(p.paragraph.rich_text, [{ type: 'text', text: { content: 'guide' } }])
})

test('strikethrough and hard line breaks are converted', () => {
  const [p] = convert('~~old~~ new  \nnext line')
  const parts = p.paragraph.rich_text
  assert.deepEqual(parts[0].annotations, { strikethrough: true })
  assert.equal(text(parts), 'old new\nnext line')
})

test('nested lists become children of their list item', () => {
  const blocks = convert('- parent\n  - child one\n  - child two\n- sibling')
  assert.equal(blocks.length, 2)
  const parent = blocks[0].bulleted_list_item
  assert.equal(text(parent.rich_text), 'parent')
  assert.equal(parent.children.length, 2)
  assert.equal(text(parent.children[1].bulleted_list_item.rich_text), 'child two')
  assert.equal(blocks[1].bulleted_list_item.children, undefined)
})

test('code blocks and sub-lists inside numbered items are kept', () => {
  const md = [
    '1. **Watch paths**:',
    '   ```',
    '   .disable-build-on-push-main',
    '   ```',
    '2. **Build settings**:',
    '   - Build command: `pnpm build`',
    '   - Deploy command: `pnpm exec wrangler deploy`',
  ].join('\n')
  const [first, second] = convert(md)
  assert.equal(first.type, 'numbered_list_item')
  assert.equal(first.numbered_list_item.children[0].type, 'code')
  assert.equal(first.numbered_list_item.children[0].code.rich_text[0].text.content, '.disable-build-on-push-main')
  const commands = second.numbered_list_item.children.map((c: any) => text(c.bulleted_list_item.rich_text))
  assert.deepEqual(commands, ['Build command: pnpm build', 'Deploy command: pnpm exec wrangler deploy'])
})

test('deeply nested lists keep every level', () => {
  const [top] = convert('- a\n  - b\n    - c\n      - d')
  const b = top.bulleted_list_item.children[0]
  const c = b.bulleted_list_item.children[0]
  const d = c.bulleted_list_item.children[0]
  assert.equal(text(d.bulleted_list_item.rich_text), 'd')
})

test('extra paragraphs of a list item become child paragraphs instead of being glued', () => {
  const [item] = convert('- first paragraph\n\n  second paragraph')
  assert.equal(text(item.bulleted_list_item.rich_text), 'first paragraph')
  assert.equal(text(item.bulleted_list_item.children[0].paragraph.rich_text), 'second paragraph')
})

test('task list items become to-do blocks', () => {
  const blocks = convert('- [ ] open\n- [x] done\n- plain')
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['to_do', 'to_do', 'bulleted_list_item']
  )
  assert.equal(blocks[0].to_do.checked, false)
  assert.equal(blocks[1].to_do.checked, true)
  assert.equal(text(blocks[1].to_do.rich_text), 'done')
})

test('blockquotes keep the first paragraph as text and nest the rest', () => {
  const [quote] = convert('> **Note** first\n>\n> second\n>\n> - item')
  assert.equal(text(quote.quote.rich_text), 'Note first')
  assert.deepEqual(
    quote.quote.children.map((c: any) => c.type),
    ['paragraph', 'bulleted_list_item']
  )
})

test('tables inside list items are nested with their rows', () => {
  const [item] = convert('- table:\n\n  | a | b |\n  |---|---|\n  | 1 | 2 |')
  const table = item.bulleted_list_item.children[0]
  assert.equal(table.type, 'table')
  assert.equal(table.table.children.length, 2)
})

test('headings deeper than H3 become H3', () => {
  const [h] = convert('#### Deep')
  assert.equal(h.type, 'heading_3')
})

test('rich text is kept within the 100-element limit', () => {
  const md = Array.from({ length: 150 }, (_, i) => `\`c${i}\``).join(' ')
  const [p] = convert(md)
  assert.ok(p.paragraph.rich_text.length <= 100)
  assert.ok(text(p.paragraph.rich_text).includes('c149'))
})

test('local images nested in lists are collected for upload', () => {
  const ast = parseMarkdown('![top](./a.png)\n\n- item\n\n  ![nested](./b.svg)\n\n![remote](https://x.io/c.png)')
  assert.deepEqual(collectLocalImages(ast), ['./a.png', './b.svg'])
})

test('uploaded images nested in blocks are replaced on retry', () => {
  const ast = parseMarkdown('- item\n\n  ![diagram](./b.svg)')
  const blocks = mdastToNotionBlocks(ast, noLink, { resolveImage: () => 'upload-1' })
  const nested = (blocks[0] as any).bulleted_list_item.children[0]
  assert.equal(nested.image.type, 'file_upload')
  const retried = withoutUploadedImages(blocks) as any[]
  assert.equal(retried[0].bulleted_list_item.children[0].type, 'paragraph')
  assert.equal(text(retried[0].bulleted_list_item.children[0].paragraph.rich_text), '[image: diagram]')
})
