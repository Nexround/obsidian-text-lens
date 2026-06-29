# OCR Images — Obsidian Plugin

An [Obsidian](https://obsidian.md) plugin that scans the active note for image references and inserts the recognized text directly below each image. Supports both a **remote PaddleX server** and a **local on-device OCR engine** (PaddleOCR v6 via ONNX Runtime).

## Features

- **One command** — `OCR Images in Current Note` processes every image in the active file
- **Three OCR modes** — Remote only / Local only / Auto (local first, fall back to remote)
- **Local engine** — runs PaddleOCR v6 on-device via ONNX Runtime; no server required after one-time runtime setup (~40 MB download)
- **Model tiers** — Tiny (~5 MB, fastest), Small (~25 MB, balanced), Medium (~60 MB, most accurate)
- **Dual syntax support** — handles both Obsidian wikilinks (`![[image.png]]`) and standard Markdown (`![alt](image.png)`)
- **URL images** — HTTP/HTTPS image URLs are passed directly to the remote OCR backend without downloading
- **Idempotent** — skips images that already have an OCR block below them (toggle-able)
- **Re-OCR** — running the command again on an already-processed note automatically replaces all existing OCR blocks
- **Two output formats** — collapsible Obsidian callout or plain fenced code block
- **Single undo step** — the entire batch edit is one `Cmd+Z` entry
- **Configurable detection** — expose all PaddleX tuning knobs (thresholds, unclip ratio, side-length limit) in the settings panel
- **Connection test** — one-click ping to verify your remote OCR server is reachable

## Requirements

- Obsidian ≥ 1.7.2 (desktop only)
- **Local mode**: no external server needed; the one-time runtime setup (Settings → OCR Images → Local OCR Engine → Setup) downloads ~40 MB of native binaries
- **Remote mode**: a running [PaddleX OCR Pipeline](https://paddlepaddle.github.io/PaddleX/latest/pipeline_usage/tutorials/ocr_pipelines/OCR.html) server exposing a `POST /ocr` HTTP endpoint

### Quick remote server start (Docker)

```bash
docker run --gpus all \
  --name paddlex \
  -p 8080:8080 \
  --shm-size=8g \
  ccr-2vdh3abv-pub.cnc.bj.baidubce.com/paddlex/paddlex:paddlex3.3.11-paddlepaddle3.2.0-gpu-cuda12.9-cudnn9.9 \
  paddlex --serve --pipeline OCR --host 0.0.0.0 --port 8080
```

## Installation

### Manual (from source)

```bash
# 1. Clone and install
git clone https://github.com/Nexround/obsidian-ocr-image.git
cd obsidian-ocr-image
npm install

# 2. Build and deploy to your vault (path is hardcoded in scripts/deploy.mjs)
npm run deploy
```

`npm run deploy` builds the plugin, pre-bundles the OCR JS libraries, and copies everything (including native runtime binaries for the current platform) into your vault's plugin directory.

### Enable in Obsidian

1. **Settings → Community Plugins** — turn off *Restricted mode*
2. Find **OCR Images** in the plugin list and toggle it **on**
3. Go to **Settings → OCR Images** and choose your OCR mode

## Usage

Open any note that contains images, then run the command palette (`Cmd/Ctrl+P`) and choose:

> **OCR Images in Current Note**

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

### OCR Engine

| Setting | Default | Description |
|---------|---------|-------------|
| **OCR mode** | Auto | `remote` — always call the remote server; `local` — run on-device; `auto` — local first, fall back to remote |
| **Model tier** | Small | `tiny` / `small` / `medium` — trades speed for accuracy. Models are downloaded once and cached at `~/.cache/ppu-paddle-ocr/` |

### Local OCR Engine

Click **Setup** to download the ONNX Runtime native binaries (~40 MB) for your platform. After setup, the engine initializes automatically in the background on next Obsidian launch.

### Remote OCR Server

| Setting | Default | Description |
|---------|---------|-------------|
| **API URL** | `http://localhost:8080/ocr` | Full URL of the PaddleX OCR endpoint |
| **Test connection** | — | Calls `GET /health` to verify the server is reachable |

### Output

| Setting | Default | Description |
|---------|---------|-------------|
| **Output format** | Callout | `> [!note]+` callout or ` ```ocr ` fenced block |
| **Skip already-processed** | On | Don't re-OCR images that already have a block below them |
| **Max concurrency** | 3 | How many OCR requests to run in parallel (1–10) |

### Remote Enhancement Options

| Setting | Default | Description |
|---------|---------|-------------|
| **Document orientation classify** | Off | Auto-detect and correct document rotation |
| **Document unwarping** | Off | Correct perspective distortion for scanned pages |
| **Text line orientation** | Off | Classify orientation of individual text lines |
| **Pixel detection threshold** | server default | `textDetThresh` — per-pixel probability cutoff |
| **Box detection threshold** | server default | `textDetBoxThresh` — bounding box confidence cutoff |
| **Unclip ratio** | server default | `textDetUnclipRatio` — box expansion factor |
| **Recognition score threshold** | server default | `textRecScoreThresh` — minimum confidence to keep result |
| **Detection side length limit** | server default | `textDetLimitSideLen` — image resize limit before detection |
| **Side length limit type** | server default | `textDetLimitType` — apply limit to `min` or `max` side |

## Development

```bash
npm run dev      # watch mode with inline source maps
npm run build    # production minified build → main.js
npm run deploy   # build + bundle ppu libs + copy everything to vault
```

### Source layout

```
src/
  main.ts           Plugin entry, commands, settings UI, OCR dispatch
  local-ocr.ts      LocalOcrEngine — wraps ppu-paddle-ocr via CJS bundle
  native-manager.ts Runtime installer — downloads onnxruntime-node & @napi-rs/canvas
scripts/
  deploy.mjs        Builds ppu-bundle.cjs and copies all artifacts to vault
```

### Why `ppu-bundle.cjs`?

Obsidian's Electron renderer loads pages from the `app://` protocol. Chromium treats a dynamic `import("file://...")` as a cross-origin request and blocks it. `deploy.mjs` pre-bundles `ppu-paddle-ocr` + `ppu-ocv` + `opencv-js` into a single CJS file (`node_modules/ppu-bundle.cjs`) so `local-ocr.ts` can load it with `require()`, which goes through Node.js's loader and has no protocol restriction.

## API Reference

The plugin communicates with the PaddleX OCR service via `POST /ocr`:

```jsonc
// Request
{
  "file": "<base64-encoded image OR https://... URL>",
  "fileType": 1,   // 1 = image (omitted for URL input)
  "useDocOrientationClassify": false,
  // ... optional detection parameters
}

// Response
{
  "errorCode": 0,
  "result": {
    "ocrResults": [{
      "prunedResult": {
        "rec_texts": ["line 1", "line 2"],   // actual recognized text
        "rec_scores": [0.98, 0.95],
        "rec_boxes": [[x1,y1,x2,y2], ...],
        "texts": []                          // always empty — use rec_texts
      }
    }]
  }
}
```

## License

MIT
