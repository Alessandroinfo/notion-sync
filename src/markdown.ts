import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Root, Content, Heading, Paragraph, Code, List, ListItem, BlockContent, PhrasingContent, Link, Image, Table, TableRow, TableCell } from 'mdast'
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

// URLs of the standalone images that point to local files, in document order.
export function collectLocalImages(ast: Root): string[] {
  const urls: string[] = []
  for (const node of ast.children) {
    const img = standaloneImage(node as Content)
    if (img && !/^[a-z][a-z0-9+.-]*:/i.test(img.url) && !urls.includes(img.url)) urls.push(img.url)
  }
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
// placeholder, for a retry when Notion refuses an uploaded image.
export function withoutUploadedImages(blocks: NotionBlock[]): NotionBlock[] {
  return blocks.map((block) => {
    const image = (block as any).image
    if ((block as any).type !== 'image' || image?.type !== 'file_upload') return block
    const label = image.caption?.[0]?.text?.content || 'image'
    return {
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: `[image: ${label}]` } }] },
    } as NotionBlock
  })
}

function imageCaption(img: Image): any[] {
  return img.alt ? [{ type: 'text', text: { content: img.alt.slice(0, RICH_TEXT_MAX) } }] : []
}

function richText(nodes: PhrasingContent[], resolveLink: (href: string) => string | null): any[] {
  const parts: any[] = []

  for (const node of nodes) {
    if (node.type === 'text') {
      for (const chunk of chunkString(node.value)) {
        parts.push({ type: 'text', text: { content: chunk } })
      }
    } else if (node.type === 'strong') {
      for (const child of node.children) {
        if (child.type === 'text') {
          parts.push({ type: 'text', text: { content: child.value }, annotations: { bold: true } })
        }
      }
    } else if (node.type === 'emphasis') {
      for (const child of node.children) {
        if (child.type === 'text') {
          parts.push({ type: 'text', text: { content: child.value }, annotations: { italic: true } })
        }
      }
    } else if (node.type === 'inlineCode') {
      parts.push({ type: 'text', text: { content: node.value }, annotations: { code: true } })
    } else if (node.type === 'link') {
      const notionPageId = resolveLink(node.url)
      const linkChildren = richText(node.children as PhrasingContent[], resolveLink)
      const label = linkChildren.map((r) => r.text?.content ?? '').join('') || node.url

      if (notionPageId) {
        // Use a text link to the Notion page URL so the custom label is preserved.
        // mention blocks always display the page title, ignoring the link text.
        parts.push({
          type: 'text',
          text: {
            content: label,
            link: { url: `https://www.notion.so/${notionPageId.replace(/-/g, '')}` },
          },
        })
      } else {
        parts.push({
          type: 'text',
          text: { content: label, link: node.url.startsWith('http') ? { url: node.url } : null },
        })
      }
    } else if (node.type === 'image') {
      // Images become plain text with the alt and url since Notion blocks require separate handling
      parts.push({ type: 'text', text: { content: `[image: ${node.alt || node.url}]` } })
    }
  }

  return parts.length ? parts : [{ type: 'text', text: { content: '' } }]
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
      const texts: PhrasingContent[] = []
      for (const child of node.children as BlockContent[]) {
        if (child.type === 'paragraph') texts.push(...(child as Paragraph).children as PhrasingContent[])
      }
      return {
        type: 'quote',
        quote: { rich_text: richText(texts, resolveLink) },
      } as NotionBlock
    }

    case 'list': {
      const list = node as List
      const blocks: NotionBlock[] = []
      for (const item of list.children as ListItem[]) {
        const texts: PhrasingContent[] = []
        for (const child of item.children as BlockContent[]) {
          if (child.type === 'paragraph') texts.push(...(child as Paragraph).children as PhrasingContent[])
        }
        const blockType = list.ordered ? 'numbered_list_item' : 'bulleted_list_item'
        blocks.push({
          type: blockType,
          [blockType]: { rich_text: richText(texts, resolveLink) },
        } as unknown as NotionBlock)
      }
      return blocks
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
