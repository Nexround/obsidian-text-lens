# TextLens — Obsidian Plugin

An [Obsidian](https://obsidian.md) plugin that scans the active note for image references and inserts the recognized text directly below each image, using a fully **on-device OCR engine** (PaddleOCR v6 via ONNX Runtime). No server, no API key, no internet connection required after the one-time runtime setup.

## Features

- **One command** — `TextLens: OCR Current Note` processes every image in the active file
- **Fully local** — runs PaddleOCR v6 on-device via ONNX Runtime; your images never leave your machine
- **Model tiers** — Tiny (~5 MB, fastest), Small (~25 MB, balanced), Medium (~60 MB, most accurate)
- **Dual syntax support** — handles both Obsidian wikilinks (`![[image.png]]`) and standard Markdown (`![alt](image.png)`)
- **Idempotent** — skips images that already have an OCR block below them (toggle-able)
- **Re-OCR** — running the command again on an already-processed note automatically replaces all existing OCR blocks
- **Two output formats** — collapsible Obsidian callout or plain fenced code block
- **Single undo step** — the entire batch edit is one `Cmd+Z` entry
- **Merge wrapped lines** — automatically joins soft-wrapped OCR lines into natural prose paragraphs

## Requirements

- Obsidian ≥ 1.7.2 (desktop only — Windows, macOS, Linux)
- One-time runtime setup (~40 MB download): **Settings → TextLens → Local OCR Engine → Setup**

## Installation

### Community Plugin (recommended)

1. Open **Settings → Community Plugins** and disable *Restricted mode*
2. Click **Browse**, search for **TextLens**, and install it
3. Enable the plugin, then go to **Settings → TextLens → Local OCR Engine** and click **Setup**

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/Nexround/obsidian-text-lens/releases/latest)
2. Copy them into `<your-vault>/.obsidian/plugins/text-lens/`
3. Reload Obsidian, enable the plugin, then run **Setup** from the settings panel

### From source

```bash
git clone https://github.com/Nexround/obsidian-text-lens.git
cd obsidian-text-lens
npm install
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` into your vault's plugin directory.

## Usage

Open any note that contains images, then open the command palette (`Cmd/Ctrl+P`) and choose:

> **TextLens: OCR Current Note**

The plugin processes each image concurrently and inserts the recognized text immediately below it.

### Callout output (default)

```markdown
![[screenshot.png]]

> [!note]+ OCR: screenshot.png
> Hello World
> This is recognized text
```

### Code block output

```markdown
![[screenshot.png]]

​```ocr
Hello World
This is recognized text
​```
```

## Settings

### Local OCR Engine

| Setting | Default | Description |
|---------|---------|-------------|
| **Setup** | — | Download ONNX Runtime native binaries (~40 MB) for your platform |
| **Model tier** | Small | `tiny` / `small` / `medium` — trades speed for accuracy. Models are downloaded once and cached at `~/.cache/ppu-paddle-ocr/` |
| **Unload / Load engine** | — | Manually control the ~200 MB ONNX inference session in memory |
| **Delete runtime files** | — | Remove all downloaded native binaries (~40 MB) from the plugin directory |
| **Clear model cache** | — | Delete cached model weights from `~/.cache/ppu-paddle-ocr/` |

### Output

| Setting | Default | Description |
|---------|---------|-------------|
| **Output format** | Callout | `> [!note]+` callout or ` ```ocr ` fenced block |
| **Skip already-processed** | On | Don't re-OCR images that already have a block below them |
| **Merge wrapped lines** | On | Join soft-wrapped OCR lines into natural prose; preserves paragraph gaps and list items |
| **Max concurrency** | 3 | How many images to OCR in parallel (1–10) |

### Diagnostics

| Setting | Default | Description |
|---------|---------|-------------|
| **Developer mode** | Off | Log each image's raw OCR result to the console (Ctrl+Shift+I) |

## Development

```bash
npm run dev      # watch mode
npm run build    # production build → main.js
```

### Source layout

```
src/
  main.ts           Plugin entry, commands, settings UI, OCR dispatch
  local-ocr.ts      LocalOcrEngine — wraps ppu-paddle-ocr via CJS bundle
  native-manager.ts Runtime installer — downloads onnxruntime-node & @napi-rs/canvas
scripts/
  build-bundle.mjs  Bundles ppu-paddle-ocr + ppu-ocv + opencv-js → ppu-bundle.cjs
  deploy.mjs        Builds and copies all artifacts to a local vault for testing
```

### Why `ppu-bundle.cjs`?

Obsidian's Electron renderer loads pages from the `app://` protocol. Chromium treats a dynamic `import("file://…")` as cross-origin and blocks it. `build-bundle.mjs` pre-bundles `ppu-paddle-ocr` into a single CJS file so `local-ocr.ts` can load it with `require()`, which uses Node.js's CJS resolver and has no protocol restriction.

`ppu-bundle.cjs` is not committed to the repository. It is built in CI and attached to each [GitHub Release](https://github.com/Nexround/obsidian-text-lens/releases) as a release asset, then downloaded on-demand by the plugin's **Setup** flow.

## License

MIT
