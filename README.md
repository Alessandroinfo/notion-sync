# notion-sync

CLI tool and GitHub Action to sync a folder of Markdown files to Notion, preserving directory hierarchy and converting internal links into Notion page references.

---

## Table of contents

- [How it works](#how-it-works)
- [Sync modes](#sync-modes)
  - [mirror](#mirror-default)
  - [graph](#graph)
- [Prerequisites](#prerequisites)
- [Local usage](#local-usage)
- [Usage as a GitHub Action](#usage-as-a-github-action)
- [Environment variables](#environment-variables)
- [Cache](#cache)
- [Supported Markdown elements](#supported-markdown-elements)
- [Limitations](#limitations)
- [Project structure](#project-structure)

---

## How it works

Given a folder of Markdown files, notion-sync creates a matching hierarchy of Notion pages and fills each page with the converted content.

Every run follows three steps:

1. **Remove** — all existing subpages under the root are deleted from Notion
2. **Create** — all pages are recreated fresh, building the chosen hierarchy
3. **Populate** — content is appended to each page; internal `.md` links are resolved to Notion page mentions

Because pages are always deleted and recreated, every sync reflects the exact current state of your files — modified, renamed, or deleted files are handled automatically.

A local cache file (`.notion-sync-cache.json`) stored in the docs folder tracks the mapping between file paths and Notion page IDs across runs.

---

## Sync modes

### `mirror` (default)

Replicates the filesystem 1:1. Every directory becomes a Notion page and every `.md` file becomes a subpage inside it. The title of each page is taken from the first `# H1` heading in the file, falling back to the filename if no H1 is found.

```
docs/
├── index.md              →  root / index
├── architecture/
│   ├── overview.md       →  root / architecture / overview
│   └── decisions.md      →  root / architecture / decisions
└── guides/
    └── setup.md          →  root / guides / setup
```

Use `mirror` when the directory structure already reflects how you want the docs organised on Notion.

---

### `graph`

Builds the Notion hierarchy from the internal links between pages, ignoring the filesystem structure. Each page's title is taken from its first `# H1`. A page becomes a child of the first page that links to it.

```
index.md  →  links to architecture.md  →  links to decisions.md

Notion result:
root / index / architecture / decisions
```

Root candidates are files with no incoming links, ranked by number of outgoing links descending (most connected first). If an `index.md` exists at the top level it is always preferred as root.

**Edge cases handled in `graph` mode:**

| Situation | Behaviour |
|-----------|-----------|
| A file is linked by multiple parents | First parent wins; subsequent links become Notion page mentions |
| Circular links (`a.md` ↔ `b.md`) | First occurrence becomes parent–child; second becomes a mention |
| Orphan files (no incoming links, not a root) | Placed at the top level with a console warning |
| Broken links (target file does not exist) | Skipped with a console warning; sync continues |
| Links that escape the docs folder (`../../x.md`) | Ignored silently |

Use `graph` when your files are written as a wiki — an `index.md` page linking to sub-topics, each sub-topic linking to detail pages — and you want Notion to mirror that logical structure rather than the folder layout.

---

## Prerequisites

### 1. Create a Notion integration

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Click **New integration**
3. Give it a name (e.g. `notion-sync`) and select your workspace
4. Under **Capabilities** enable: *Read content*, *Update content*, *Insert content*
5. Copy the **Internal Integration Secret** — this will be your `NOTION_API_KEY`

### 2. Share access with the integration

**With a root page (`NOTION_PAGE_ID` set):**
All docs will be created as subpages of one specific Notion page. Recommended when the workspace is shared with others or you want the docs isolated.

1. Open the Notion page you want to use as root
2. Click **...** (top-right menu) → **Connections** → add your integration
3. Copy the page ID from the URL:
   ```
   https://notion.so/Page-Title-<PAGE_ID>
   ```
   The ID is the last segment (32 hex characters, with or without hyphens)

**Without a root page (`NOTION_PAGE_ID` omitted):**
Top-level pages appear directly in the workspace sidebar.

1. Go to workspace **Settings** → **Connections**
2. Add the integration at workspace level

---

## Local usage

```bash
git clone https://github.com/Alessandroinfo/notion-sync.git
cd notion-sync
npm install
```

**Sync under a specific Notion page:**
```bash
NOTION_API_KEY=secret_xxx \
NOTION_PAGE_ID=abc123 \
npx tsx src/index.ts /path/to/your/docs
```

**Sync to the workspace root:**
```bash
NOTION_API_KEY=secret_xxx \
npx tsx src/index.ts /path/to/your/docs
```

**Choose sync mode:**
```bash
# mirror mode (default) — filesystem hierarchy
npx tsx src/index.ts --mode mirror /path/to/docs

# graph mode — hierarchy derived from internal links
npx tsx src/index.ts --mode graph /path/to/docs

# via env var (useful in CI)
NOTION_SYNC_MODE=graph npx tsx src/index.ts /path/to/docs
```

All options can be combined:
```bash
NOTION_API_KEY=secret_xxx \
NOTION_PAGE_ID=abc123 \
NOTION_SYNC_MODE=graph \
npx tsx src/index.ts /path/to/docs
```

---

## Usage as a GitHub Action

Add this workflow to the repo that contains your docs and trigger it manually whenever you want to sync.

```yaml
# .github/workflows/notion-sync.yml
name: Sync docs to Notion

on:
  workflow_dispatch:
    inputs:
      doc_path:
        description: 'Docs folder in the repo (e.g. doc, docs/en)'
        required: true
        default: 'doc'
      mode:
        description: 'Sync mode: mirror (filesystem) or graph (link-based hierarchy)'
        required: false
        default: 'mirror'

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: Alessandroinfo/notion-sync@main
        with:
          doc_path: ${{ inputs.doc_path }}
          notion_api_key: ${{ secrets.NOTION_API_KEY }}
          notion_page_id: ${{ secrets.NOTION_PAGE_ID }}
          mode: ${{ inputs.mode }}
```

Trigger from **Actions → Sync docs to Notion → Run workflow**.

### Configuring secrets

Go to **Settings → Secrets and variables → Actions → New repository secret** in the repo that contains the docs.

**With a root page:**

| Secret | Description |
|--------|-------------|
| `NOTION_API_KEY` | Notion Internal Integration Secret |
| `NOTION_PAGE_ID` | ID of the Notion page to use as root |

**Without a root page:**

| Secret | Description |
|--------|-------------|
| `NOTION_API_KEY` | Notion Internal Integration Secret |

> Do not add `NOTION_PAGE_ID` — pages will be created directly in the workspace sidebar.

---

## Environment variables

| Variable | Required | CLI equivalent | Description |
|----------|:--------:|----------------|-------------|
| `NOTION_API_KEY` | ✅ | — | Notion Internal Integration Secret |
| `NOTION_PAGE_ID` | ❌ | — | Notion page ID to sync under. If omitted, pages go to the workspace root |
| `NOTION_DOC_PATH` | ❌ | first positional argument | Path to the docs folder |
| `NOTION_SYNC_MODE` | ❌ | `--mode mirror\|graph` | Sync mode. Default: `mirror` |

When both the env var and the CLI flag are provided, the env var takes precedence (useful for overriding defaults in CI).

---

## Cache

`.notion-sync-cache.json` is written to the docs folder after each successful sync. It maps every relative file path to its Notion page ID so that the "remove existing pages" step in the next run targets the right pages.

Add it to the `.gitignore` of the project that contains the docs:

```
.notion-sync-cache.json
```

The cache is automatically invalidated (and all pages recreated) if `NOTION_PAGE_ID` changes.

---

## Supported Markdown elements

| Markdown | Notion block |
|----------|-------------|
| `# H1` / `## H2` / `### H3` | Heading 1 / 2 / 3 |
| Paragraph text | Paragraph |
| `**bold**` | Bold annotation |
| `*italic*` | Italic annotation |
| `` `inline code` `` | Code annotation |
| `[text](./file.md)` | Mention → Notion page |
| `[text](https://...)` | External link |
| ` ```lang ``` ` | Code block (language normalised to Notion's accepted values) |
| `> blockquote` | Quote block |
| `- item` / `1. item` | Bulleted / Numbered list |
| `---` | Divider |
| `![alt](https://url)` | Image block (external URLs only) |

Code blocks longer than 2000 characters are automatically split into consecutive blocks to comply with Notion's API limit.

---

## Limitations

- **Local images** — Notion's API does not accept file uploads. Images referenced by local path (e.g. `./images/diagram.png`) are skipped. Only images with an external `https://` URL are synced.
- **Heading depth** — Headings deeper than H3 are converted to H3, as Notion only supports three heading levels.
- **Tables** — Markdown tables are not yet converted to Notion table blocks; they are rendered as plain paragraphs.
- **HTML blocks** — Raw HTML inside `.md` files is ignored.
- **graph mode + workspace root** — If `NOTION_PAGE_ID` is not set and mode is `graph`, orphan pages are created at the workspace root but cannot be automatically cleaned up on subsequent runs (there is no way to list all workspace-level pages via the API without a database). Use `NOTION_PAGE_ID` with `graph` mode for reliable cleanup.

---

## Project structure

```
notion-sync/
├── src/
│   ├── index.ts      Entry point — reads config from CLI args and env vars
│   ├── sync.ts       Orchestrates the three-pass sync (remove → create → populate)
│   ├── graph.ts      Builds the page tree from internal links (graph mode only)
│   ├── fs.ts         Scans the docs folder and builds a flat FileNode tree
│   ├── markdown.ts   Parses Markdown AST and converts nodes to Notion blocks
│   ├── notion.ts     Thin wrapper around the Notion API client
│   ├── cache.ts      Reads and writes .notion-sync-cache.json
│   └── types.ts      Shared TypeScript types
├── action.yml        GitHub Action definition
└── .github/
    └── workflows/
        └── example-sync.yml   Ready-to-use workflow to copy into your repo
```
