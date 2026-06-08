import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Root, Content, Heading, Paragraph, Code, List, ListItem, BlockContent, PhrasingContent, Link, Image } from 'mdast'
import type { BlockObjectRequest } from '@notionhq/client/build/src/api-endpoints.js'

type NotionBlock = BlockObjectRequest

const RICH_TEXT_MAX = 2000

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

// resolveLink: called with the raw href from the .md file, returns a Notion page ID or null
export function mdastToNotionBlocks(
  ast: Root,
  resolveLink: (href: string) => string | null,
  opts: { skipFirstH1?: boolean } = {}
): NotionBlock[] {
  const blocks: NotionBlock[] = []
  let firstH1Skipped = false

  for (const node of ast.children) {
    if (opts.skipFirstH1 && !firstH1Skipped && node.type === 'heading' && (node as Heading).depth === 1) {
      firstH1Skipped = true
      continue
    }
    const converted = convertNode(node as Content, resolveLink)
    if (converted) blocks.push(...(Array.isArray(converted) ? converted : [converted]))
  }

  return blocks
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
        parts.push({
          type: 'mention',
          mention: { type: 'page', page: { id: notionPageId } },
          plain_text: label,
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
  resolveLink: (href: string) => string | null
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
      // A paragraph with a single image becomes an image block
      if (
        p.children.length === 1 &&
        p.children[0].type === 'image'
      ) {
        const img = p.children[0] as Image
        if (img.url.startsWith('http')) {
          return {
            type: 'image',
            image: { type: 'external', external: { url: img.url } },
          } as NotionBlock
        }
      }
      return {
        type: 'paragraph',
        paragraph: { rich_text: richText(p.children as PhrasingContent[], resolveLink) },
      } as NotionBlock
    }

    case 'code': {
      const c = node as Code
      const lang = (c.lang as any) || 'plain text'
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

    case 'thematicBreak':
      return { type: 'divider', divider: {} } as NotionBlock

    case 'html':
      return null

    default:
      return null
  }
}
