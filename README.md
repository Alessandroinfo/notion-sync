# notion-sync

CLI tool and GitHub Action to sync a folder of Markdown files to Notion, preserving the directory hierarchy and converting internal links between files into Notion page references.

## How it works

Given a file structure:

```
doc/
├── index.md
├── architecture/
│   ├── overview.md
│   └── decisions.md
└── guides/
    └── setup.md
```

It is replicated on Notion as a hierarchy of pages.

**With `NOTION_PAGE_ID` — everything isolated under a specific page:**
```
Your page (NOTION_PAGE_ID)
├── index
├── architecture/
│   ├── overview
│   └── decisions
└── guides/
    └── setup
```

**Without `NOTION_PAGE_ID` — pages created at the workspace root:**
```
Workspace
├── index
├── architecture/
│   ├── overview
│   └── decisions
└── guides/
    └── setup
```

Internal links between files (`[See overview](../architecture/overview.md)`) are converted into clickable links to the corresponding Notion pages.

## Sync modes

### `mirror` (default)
Replicates the filesystem 1:1. Every folder becomes a Notion page, every `.md` file becomes a subpage. The hierarchy matches your directory structure exactly.

```
doc/architecture/overview.md → Notion: root / architecture / overview
```

### `graph`
Builds the Notion hierarchy from internal links between pages, not from the filesystem. Each page's title comes from its first H1. A page becomes a child of the first page that links to it.

```
index.md links to → architecture.md links to → decisions.md
Notion:  index / architecture / decisions
```

Edge cases handled:
- **Multiple parents** — first-parent wins; subsequent links become Notion mentions
- **Circular links** — second occurrence stays as mention, no loop
- **Orphans** (no incoming links) — placed at root with a warning
- **Broken links** — skipped with a warning, sync continues
- **Links outside docs folder** — ignored

### Sync logic (both modes)

Every run:
1. **Remove** all existing subpages under the root
2. **Create** all pages fresh, replicating the chosen hierarchy
3. **Populate** content, resolving internal links to Notion page mentions

A local cache (`.notion-sync-cache.json`) in the docs folder tracks the mapping between file paths and Notion page IDs.

---

## Prerequisites

### 1. Create a Notion integration

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Click **New integration**
3. Give it a name (e.g. `notion-sync`) and select your workspace
4. Under **Capabilities** enable: *Read content*, *Update content*, *Insert content*
5. Copy the **Internal Integration Secret** → this will be `NOTION_API_KEY`

### 2. Share access with the integration

**Mode A — specific root page (with `NOTION_PAGE_ID`):**
Use this to keep docs isolated from the rest of the workspace, or when sharing the workspace with others.
1. Open the Notion page you want to use as root
2. Click **...** (top-right menu) → **Connections** → add your integration
3. Copy the ID from the URL: `https://notion.so/Page-Title-**<PAGE_ID>**` → the last part (32 hex characters)

**Mode B — workspace root (without `NOTION_PAGE_ID`):**
Top-level pages will appear directly in the workspace sidebar with no container page.
1. Go to workspace **Settings** → **Connections**
2. Add the integration at workspace level

---

## Local usage

```bash
git clone https://github.com/Alessandroinfo/notion-sync.git
cd notion-sync
npm install
```

**Mode A — everything under a specific page:**
```bash
NOTION_API_KEY=secret_xxx \
NOTION_PAGE_ID=abc123 \
npx tsx src/index.ts /path/to/your/docs
```

**Mode B — pages at the workspace root:**
```bash
NOTION_API_KEY=secret_xxx \
npx tsx src/index.ts /path/to/your/docs
```

**Choose sync mode with `--mode` flag or env var:**
```bash
# mirror mode (default) — filesystem hierarchy
npx tsx src/index.ts --mode mirror /path/to/docs

# graph mode — hierarchy from internal links
npx tsx src/index.ts --mode graph /path/to/docs

# via env var (useful in CI)
NOTION_SYNC_MODE=graph npx tsx src/index.ts /path/to/docs
```

---

## Usage as a GitHub Action

Add this workflow to the repo that contains your docs:

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

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: Alessandroinfo/notion-sync@main
        with:
          doc_path: ${{ inputs.doc_path }}
          notion_api_key: ${{ secrets.NOTION_API_KEY }}
          notion_page_id: ${{ secrets.NOTION_PAGE_ID }}  # omit to use workspace root
          mode: mirror  # or graph
```

The workflow is triggered manually from **Actions → Sync docs to Notion → Run workflow**.

### Configuring Secrets

In the repo that contains the docs go to **Settings → Secrets and variables → Actions → New repository secret**.

**Mode A — everything under a specific page:**

| Secret | Description |
|--------|-------------|
| `NOTION_API_KEY` | Notion Internal Integration Secret |
| `NOTION_PAGE_ID` | ID of the Notion page to use as root |

**Mode B — pages at the workspace root:**

| Secret | Description |
|--------|-------------|
| `NOTION_API_KEY` | Notion Internal Integration Secret |

> Do not add `NOTION_PAGE_ID`. Pages will be created directly in the workspace.

---

## Environment variables

| Variable | Required | Description |
|----------|:--------:|-------------|
| `NOTION_API_KEY` | ✅ | Notion Internal Integration Secret |
| `NOTION_PAGE_ID` | ❌ | ID of the Notion page to sync under. If omitted, pages are created at the workspace root |
| `NOTION_DOC_PATH` | ❌ | Path to the docs folder. Alternative to passing it as a CLI argument |
| `NOTION_SYNC_MODE` | ❌ | `mirror` or `graph`. Default: `mirror`. Overrides `--mode` flag |

> **Rule of thumb:** use `NOTION_PAGE_ID` if you want to keep docs separate from the rest of the workspace or if you share the workspace with others. Omit it if you want pages to appear directly in the sidebar.

---

## Cache

The `.notion-sync-cache.json` file is saved in the docs folder. It maps each relative path to its Notion page ID. Add it to the `.gitignore` of the project that contains the docs:

```
.notion-sync-cache.json
```

If `NOTION_PAGE_ID` changes, the cache is automatically invalidated and all pages are recreated.

---

## Supported Markdown elements

| Element | Notion block |
|---------|-------------|
| `# H1` `## H2` `### H3` | Heading 1/2/3 |
| Paragraph | Paragraph |
| `**bold**` `*italic*` `` `inline code` `` | Rich text annotations |
| `[text](./file.md)` | Mention → Notion page |
| `[text](https://...)` | External link |
| ` ```code``` ` | Code block |
| `>` Blockquote | Quote |
| `- list` / `1. list` | Bulleted / Numbered list |
| `---` | Divider |
| `![alt](https://...)` | Image (external URLs only) |
