# notion-sync

Strumento CLI e GitHub Action per sincronizzare una cartella di file Markdown su Notion, rispettando la struttura delle directory e convertendo i link interni tra file in riferimenti tra pagine Notion.

## Come funziona

Data una struttura di file:

```
doc/
├── index.md
├── architecture/
│   ├── overview.md
│   └── decisions.md
└── guides/
    └── setup.md
```

Viene replicata su Notion come gerarchia di pagine.

**Con `NOTION_PAGE_ID` — tutto isolato sotto una pagina specifica:**
```
La tua pagina (NOTION_PAGE_ID)
├── index
├── architecture/
│   ├── overview
│   └── decisions
└── guides/
    └── setup
```

**Senza `NOTION_PAGE_ID` — pagine create nella root del workspace:**
```
Workspace
├── index
├── architecture/
│   ├── overview
│   └── decisions
└── guides/
    └── setup
```

I link interni tra file (`[Vedi overview](../architecture/overview.md)`) vengono convertiti in link cliccabili alle rispettive pagine Notion.

### Logica di sincronizzazione

La sync avviene in due passaggi:

1. **Creazione pagine** — tutte le pagine vengono create su Notion replicando la gerarchia, prima di scrivere qualsiasi contenuto
2. **Sync contenuto** — ogni file viene convertito in blocchi Notion; i link interni vengono risolti usando gli ID delle pagine create nel passo precedente

Alla prima esecuzione le pagine vengono create. Alle esecuzioni successive il contenuto viene **svuotato e riscritto** — le pagine restano le stesse (stesso ID Notion), quindi i link interni rimangono validi.

Una cache locale (`.notion-sync-cache.json`) nella cartella dei docs tiene traccia della corrispondenza tra path dei file e ID delle pagine Notion, così le pagine non vengono ricreate ad ogni sync.

---

## Prerequisiti

### 1. Creare un'integrazione Notion

1. Vai su [notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Clicca **New integration**
3. Assegna un nome (es. `notion-sync`) e seleziona il workspace
4. Sotto **Capabilities** abilita: *Read content*, *Update content*, *Insert content*
5. Copia l'**Internal Integration Secret** → sarà `NOTION_API_KEY`

### 2. Condividere l'accesso con l'integrazione

Hai due modalità, scegli quella che preferisci:

**Modalità A — pagina isolata (con `NOTION_PAGE_ID`)**
Tutta la documentazione viene creata come sottopagine di una pagina Notion specifica. Utile per tenere i docs separati dal resto del workspace.
1. Apri la pagina Notion che vuoi usare come root
2. Clicca **...** (menu in alto a destra) → **Connections** → aggiungi la tua integrazione
3. Copia l'ID dalla URL: `https://notion.so/Il-Titolo-**<PAGE_ID>**` → la parte finale (32 caratteri esadecimali)

**Modalità B — workspace root (senza `NOTION_PAGE_ID`)**
Le pagine di primo livello vengono create direttamente nella sidebar del workspace, senza nessuna pagina contenitore.
1. Vai su **Settings** del workspace → **Connections**
2. Aggiungi l'integrazione a livello workspace

---

## Uso in locale

```bash
git clone https://github.com/Alessandroinfo/notion-sync.git
cd notion-sync
npm install
```

**Modalità A — tutto sotto una pagina specifica:**
```bash
NOTION_API_KEY=secret_xxx \
NOTION_PAGE_ID=abc123 \
npx tsx src/index.ts /percorso/della/tua/cartella/docs
```

**Modalità B — pagine nella root del workspace:**
```bash
NOTION_API_KEY=secret_xxx \
npx tsx src/index.ts /percorso/della/tua/cartella/docs
```

---

## Uso come GitHub Action

Aggiungi questo workflow nel repo che contiene i tuoi docs:

```yaml
# .github/workflows/notion-sync.yml
name: Sync docs to Notion

on:
  workflow_dispatch:
    inputs:
      doc_path:
        description: 'Cartella dei docs nel repo (es: doc, docs/en)'
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
          notion_page_id: ${{ secrets.NOTION_PAGE_ID }}  # ometti per usare la root del workspace
```

Il workflow si attiva manualmente da **Actions → Sync docs to Notion → Run workflow**.

### Configurare i Secrets

Nel repo che contiene i docs vai su **Settings → Secrets and variables → Actions → New repository secret**.

**Modalità A — tutto sotto una pagina specifica:**

| Secret | Descrizione |
|--------|-------------|
| `NOTION_API_KEY` | Internal Integration Secret di Notion |
| `NOTION_PAGE_ID` | ID della pagina Notion da usare come root |

**Modalità B — pagine nella root del workspace:**

| Secret | Descrizione |
|--------|-------------|
| `NOTION_API_KEY` | Internal Integration Secret di Notion |

> Non aggiungere `NOTION_PAGE_ID`. Le pagine verranno create direttamente nel workspace.

---

## Variabili d'ambiente

| Variabile | Obbligatoria | Descrizione |
|-----------|:---:|-------------|
| `NOTION_API_KEY` | ✅ | Internal Integration Secret di Notion |
| `NOTION_PAGE_ID` | ❌ | ID della pagina Notion sotto cui isolare i docs. Se omesso, le pagine vengono create nella root del workspace |
| `NOTION_DOC_PATH` | ❌ | Percorso della cartella docs. Alternativa al primo argomento CLI |

> **Regola pratica:** usa `NOTION_PAGE_ID` se vuoi tenere i docs separati dal resto del workspace o se condividi il workspace con altre persone. Omettilo se vuoi che le pagine appaiano direttamente nella sidebar.

---

## Cache

Il file `.notion-sync-cache.json` viene salvato nella cartella dei docs. Mappa ogni path relativo al suo Notion page ID. Va aggiunto al `.gitignore` del progetto che contiene i docs:

```
.notion-sync-cache.json
```

Se si cambia `NOTION_PAGE_ID`, la cache viene invalidata automaticamente e tutte le pagine vengono ricreate.

---

## Elementi Markdown supportati

| Elemento | Blocco Notion |
|----------|---------------|
| `# H1` `## H2` `### H3` | Heading 1/2/3 |
| Paragrafo | Paragraph |
| `**grassetto**` `*corsivo*` `` `inline code` `` | Annotazioni rich text |
| `[testo](./file.md)` | Mention → pagina Notion |
| `[testo](https://...)` | Link esterno |
| ` ```codice``` ` | Code block |
| `>` Blockquote | Quote |
| `- lista` / `1. lista` | Bulleted / Numbered list |
| `---` | Divider |
| `![alt](https://...)` | Image (solo URL esterni) |
