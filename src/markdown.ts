import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Root, Content, Heading, Paragraph, Code, List, ListItem, PhrasingContent, Image, Table, TableRow, TableCell } from 'mdast'
import type { BlockObjectRequest } from '@notionhq/client/build/src/api-endpoints.js'

type NotionBlock = BlockObjectRequest

const RICH_TEXT_MAX = 2000

const NOTION_LANGUAGES = new Set([
  'abap','abc','agda','arduino','ascii art','assembly','bash','basic','bnf','c','c#','c++',
  'clojure','coffeescript','coq','css','dart','dhall','diff','docker','ebnf','elixir','elm',
  'erlang','f#','flow','fortran','gherkin','glsl','go','graphql','groovy','haskell','hcl',
  'html','idris','java','javascript','json','julia','kotlin','latex','less','lisp','livescript',
  'llvm ir','lua','makefile','markdown','markup','matlab','mathematica','mermaid','nix',
  'notion formula','objective-c','ocaml','pascal','perl','php','plain text','powershell',
  'prolog','protobuf','purescript','python','r','racket','reason','ruby','rust','sass','scala',
  'scheme','scss','shell','smalltalk','solidity','sql','swift','toml','typescript','vb.net',
  'verilog','vhdl','visual basic','webassembly','xml','yaml','java/c/c++/c#',
])

// Maps common markdown language identifiers to Notion-accepted values.
const LANGUAGE_ALIASES: Record<string, string> = {
  sh: 'bash', zsh: 'bash', text: 'plain text', txt: 'plain text',
  js: 'javascript', ts: 'typescript', py: 'python', rb: 'ruby',
  rs: 'rust', kt: 'kotlin', md: 'markdown', yml: 'yaml',
  tf: 'hcl', dockerfile: 'docker', 'c++': 'c++', cpp: 'c++',
  cs: 'c#', csharp: 'c#', objc: 'objective-c',
}

function normalizeLanguage(lang: string | null | undefined): string {
  if (!lang) return 'plain text'
  const lower = lang.toLowerCase().trim()
  if (NOTION_LANGUAGES.has(lower)) return lower
  return LANGUAGE_ALIASES[lower] ?? 'plain text'
}

// Splits a string into chunks of at most RICH_TEXT_MAX characters.
function chunkString(str: string): string[] {
  const chunks: string[] = []
  for (let i = 0; i < str.length; i += RICH_TEXT_MAX) {
    chunks.push(str.slice(i, i + RICH_TEXT_MAX))
  }
  return chunks.length ? chunks : ['']
}

export function parseMarkdown(content: string): Root {
  return unified().use(remarkParse).use(remarkGfm).parse(content) as Root
}

// Returns the text content of the first H1 in the AST, or null if not found.
export function extractTitle(ast: Root): string | null {
  for (const node of ast.children) {
    if (node.type === 'heading' && (node as Heading).depth === 1) {
      return (node as Heading).children
        .filter((c) => c.type === 'text')
        .map((c) => (c as any).value as string)
        .join('')
        .trim() || null
    }
  }
  return null
}

// Returns the image of a paragraph that contains only that image: the one
// case converted to an image block (images inside text stay a placeholder).
function standaloneImage(node: Content): Image | null {
  if (node.type !== 'paragraph') return null
  const children = (node as Paragraph).children
  return children.length === 1 && children[0].type === 'image' ? (children[0] as Image) : null
}

// URLs of the standalone images that point to local files, in document order,
// including those nested in list items and blockquotes.
export function collectLocalImages(ast: Root): string[] {
  const urls: string[] = []
  const visit = (nodes: Content[]) => {
    for (const node of nodes) {
      const img = standaloneImage(node)
      if (img && !/^[a-z][a-z0-9+.-]*:/i.test(img.url) && !urls.includes(img.url)) urls.push(img.url)
      if (node.type !== 'paragraph' && 'children' in node) visit(node.children as Content[])
    }
  }
  visit(ast.children as Content[])
  return urls
}

// resolveLink: called with the raw href from the .md file, returns a Notion page ID or null
// resolveImage: called with the raw url of a local image, returns its file upload ID or null
export function mdastToNotionBlocks(
  ast: Root,
  resolveLink: (href: string) => string | null,
  opts: { skipFirstH1?: boolean; resolveImage?: (url: string) => string | null } = {}
): NotionBlock[] {
  const blocks: NotionBlock[] = []
  let firstH1Skipped = false
  const resolveImage = opts.resolveImage ?? (() => null)

  for (const node of ast.children) {
    if (opts.skipFirstH1 && !firstH1Skipped && node.type === 'heading' && (node as Heading).depth === 1) {
      firstH1Skipped = true
      continue
    }
    const converted = convertNode(node as Content, resolveLink, resolveImage)
    if (converted) blocks.push(...(Array.isArray(converted) ? converted : [converted]))
  }

  return blocks
}

// Replaces image blocks that reference file uploads with their text
// placeholder, for a retry when Notion refuses an uploaded image. Nested
// blocks (list items, quotes) are handled too.
export function withoutUploadedImages(blocks: NotionBlock[]): NotionBlock[] {
  return blocks.map((block) => {
    const image = (block as any).image
    if ((block as any).type === 'image' && image?.type === 'file_upload') {
      const label = image.caption?.[0]?.text?.content || 'image'
      return {
        type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: `[image: ${label}]` } }] },
      } as NotionBlock
    }
    const type = (block as any).type as string
    const body = (block as any)[type]
    if (!Array.isArray(body?.children)) return block
    return { ...block, [type]: { ...body, children: withoutUploadedImages(body.children) } } as NotionBlock
  })
}

function imageCaption(img: Image): any[] {
  return img.alt ? [{ type: 'text', text: { content: img.alt.slice(0, RICH_TEXT_MAX) } }] : []
}

// Notion accepts at most 100 elements in a rich text array.
const RICH_TEXT_MAX_ITEMS = 100

interface Annotations {
  bold?: boolean
  italic?: boolean
  strikethrough?: boolean
  code?: boolean
}

function textPart(content: string, annotations: Annotations, link: string | null): any {
  const part: any = { type: 'text', text: link ? { content, link: { url: link } } : { content } }
  if (Object.keys(annotations).length > 0) part.annotations = { ...annotations }
  return part
}

function sameStyle(a: any, b: any): boolean {
  return (
    JSON.stringify(a.annotations ?? {}) === JSON.stringify(b.annotations ?? {}) &&
    (a.text.link?.url ?? null) === (b.text.link?.url ?? null)
  )
}

// Keeps a rich text array within Notion's 100-element limit: adjacent parts
// with the same style are merged first; if that is not enough, the tail is
// kept as plain text in the last element instead of failing the whole page.
function limitRichText(parts: any[]): any[] {
  if (parts.length <= RICH_TEXT_MAX_ITEMS) return parts

  const merged: any[] = []
  for (const part of parts) {
    const last = merged[merged.length - 1]
    if (last && sameStyle(last, part) && last.text.content.length + part.text.content.length <= RICH_TEXT_MAX) {
      merged[merged.length - 1] = { ...last, text: { ...last.text, content: last.text.content + part.text.content } }
    } else {
      merged.push(part)
    }
  }
  if (merged.length <= RICH_TEXT_MAX_ITEMS) return merged

  const head = merged.slice(0, RICH_TEXT_MAX_ITEMS - 1)
  const tail = merged.slice(RICH_TEXT_MAX_ITEMS - 1).map((p) => p.text.content).join('')
  return [...head, { type: 'text', text: { content: tail.slice(0, RICH_TEXT_MAX) } }]
}

// Converts inline Markdown to rich text parts. Formatting nests (a bold span
// can contain code or a link, a link label can be bold), so every child
// inherits the annotations and the link of its ancestors.
function inlineParts(
  nodes: PhrasingContent[],
  resolveLink: (href: string) => string | null,
  annotations: Annotations,
  link: string | null
): any[] {
  const parts: any[] = []

  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        for (const chunk of chunkString(node.value)) parts.push(textPart(chunk, annotations, link))
        break
      case 'inlineCode':
        for (const chunk of chunkString(node.value)) parts.push(textPart(chunk, { ...annotations, code: true }, link))
        break
      case 'strong':
        parts.push(...inlineParts(node.children as PhrasingContent[], resolveLink, { ...annotations, bold: true }, link))
        break
      case 'emphasis':
        parts.push(...inlineParts(node.children as PhrasingContent[], resolveLink, { ...annotations, italic: true }, link))
        break
      case 'delete':
        parts.push(...inlineParts(node.children as PhrasingContent[], resolveLink, { ...annotations, strikethrough: true }, link))
        break
      case 'break':
        parts.push(textPart('\n', annotations, link))
        break
      case 'link': {
        // Internal .md links point to the Notion page through a text link, so
        // the custom label is preserved (mentions always show the page title).
        const notionPageId = resolveLink(node.url)
        const url = notionPageId
          ? `https://www.notion.so/${notionPageId.replace(/-/g, '')}`
          : node.url.startsWith('http') ? node.url : null
        const label = inlineParts(node.children as PhrasingContent[], resolveLink, annotations, url)
        const hasText = label.some((p) => p.text.content.length > 0)
        parts.push(...(hasText ? label : [textPart(node.url, annotations, url)]))
        break
      }
      case 'image':
        // Inline images stay a text placeholder; only standalone images become image blocks.
        parts.push(textPart(`[image: ${node.alt || node.url}]`, annotations, link))
        break
      default:
        // Inline HTML and other unsupported nodes are skipped.
        break
    }
  }

  return parts
}

function richText(nodes: PhrasingContent[], resolveLink: (href: string) => string | null): any[] {
  const parts = inlineParts(nodes, resolveLink, {}, null)
  return parts.length ? limitRichText(parts) : [{ type: 'text', text: { content: '' } }]
}

// Converts sibling Markdown nodes, flattening nodes that produce several blocks.
function convertBlocks(
  nodes: Content[],
  resolveLink: (href: string) => string | null,
  resolveImage: (url: string) => string | null
): NotionBlock[] {
  const blocks: NotionBlock[] = []
  for (const node of nodes) {
    const converted = convertNode(node, resolveLink, resolveImage)
    if (converted) blocks.push(...(Array.isArray(converted) ? converted : [converted]))
  }
  return blocks
}

// Splits a container (list item, blockquote) into the text of its first
// paragraph and the blocks that follow it, which become nested children.
function leadAndChildren(
  children: Content[],
  resolveLink: (href: string) => string | null,
  resolveImage: (url: string) => string | null
): { richText: any[]; children: NotionBlock[] } {
  const [first, ...rest] = children
  if (first?.type === 'paragraph' && !standaloneImage(first)) {
    return {
      richText: richText((first as Paragraph).children as PhrasingContent[], resolveLink),
      children: convertBlocks(rest, resolveLink, resolveImage),
    }
  }
  return { richText: richText([], resolveLink), children: convertBlocks(children, resolveLink, resolveImage) }
}

function convertNode(
  node: Content,
  resolveLink: (href: string) => string | null,
  resolveImage: (url: string) => string | null
): NotionBlock | NotionBlock[] | null {
  switch (node.type) {
    case 'heading': {
      const h = node as Heading
      const level = Math.min(h.depth, 3) as 1 | 2 | 3
      const typeMap = { 1: 'heading_1', 2: 'heading_2', 3: 'heading_3' } as const
      const blockType = typeMap[level]
      return {
        type: blockType,
        [blockType]: {
          rich_text: richText(h.children as PhrasingContent[], resolveLink),
        },
      } as unknown as NotionBlock
    }

    case 'paragraph': {
      const p = node as Paragraph
      // A paragraph with a single image becomes an image block: external URLs
      // are linked, local files are referenced through their file upload.
      const img = standaloneImage(p)
      if (img) {
        if (img.url.startsWith('http')) {
          return {
            type: 'image',
            image: { type: 'external', external: { url: img.url }, caption: imageCaption(img) },
          } as NotionBlock
        }
        const uploadId = resolveImage(img.url)
        if (uploadId) {
          return {
            type: 'image',
            image: { type: 'file_upload', file_upload: { id: uploadId }, caption: imageCaption(img) },
          } as unknown as NotionBlock
        }
      }
      return {
        type: 'paragraph',
        paragraph: { rich_text: richText(p.children as PhrasingContent[], resolveLink) },
      } as NotionBlock
    }

    case 'code': {
      const c = node as Code
      const lang = normalizeLanguage(c.lang)
      // Notion limits rich_text content to 2000 chars — split long code blocks into multiple blocks.
      return chunkString(c.value).map((chunk) => ({
        type: 'code',
        code: {
          rich_text: [{ type: 'text', text: { content: chunk } }],
          language: lang,
        },
      })) as unknown as NotionBlock[]
    }

    case 'blockquote': {
      // The first paragraph is the quote text; following paragraphs, lists
      // and code blocks are nested inside the quote.
      const { richText: text, children } = leadAndChildren(node.children as Content[], resolveLink, resolveImage)
      return {
        type: 'quote',
        quote: { rich_text: text, ...(children.length ? { children } : {}) },
      } as NotionBlock
    }

    case 'list': {
      const list = node as List
      return (list.children as ListItem[]).map((item) => {
        // The first paragraph is the item text; nested lists, code blocks,
        // quotes and further paragraphs become children of the item.
        const { richText: text, children } = leadAndChildren(item.children as Content[], resolveLink, resolveImage)
        // GFM task list items ("- [ ]" / "- [x]") become to-do blocks.
        const isTask = typeof item.checked === 'boolean'
        const blockType = isTask ? 'to_do' : list.ordered ? 'numbered_list_item' : 'bulleted_list_item'
        return {
          type: blockType,
          [blockType]: {
            rich_text: text,
            ...(isTask ? { checked: item.checked } : {}),
            ...(children.length ? { children } : {}),
          },
        } as unknown as NotionBlock
      })
    }

    case 'table': {
      const table = node as Table
      const rows = table.children as TableRow[]
      const columnCount = rows[0]?.children.length ?? 0
      if (columnCount === 0) return null

      const tableBlock: any = {
        type: 'table',
        table: {
          table_width: columnCount,
          has_column_header: true,
          has_row_header: false,
          children: rows.map((row) => ({
            type: 'table_row',
            table_row: {
              cells: (row.children as TableCell[]).map((cell) =>
                richText(cell.children as PhrasingContent[], resolveLink)
              ),
            },
          })),
        },
      }
      return tableBlock as NotionBlock
    }

    case 'thematicBreak':
      return { type: 'divider', divider: {} } as NotionBlock

    case 'html':
      return null

    default:
      return null
  }
}
