# OCR Images — Obsidian Plugin

An [Obsidian](https://obsidian.md) plugin that scans the active note for image references, sends each image to a [PaddleX](https://github.com/PaddlePaddle/PaddleX) OCR backend, and inserts the recognized text directly below the image in your note.

## Features

- **One command** — `OCR Images in Current Note` processes every image in the active file
- **Dual syntax support** — handles both Obsidian wikilinks (`![[image.png]]`) and standard Markdown (`![alt](image.png)`)
- **URL images** — HTTP/HTTPS image URLs are passed directly to the OCR backend without downloading
- **Idempotent** — skips images that already have an OCR block below them (toggle-able)
- **Two output formats** — collapsible Obsidian callout or plain fenced code block
- **Single undo step** — the entire batch edit is one `Cmd+Z` entry
- **Configurable detection** — expose all PaddleX tuning knobs (thresholds, unclip ratio, side-length limit) in the settings panel
- **Connection test** — one-click ping to verify your OCR server is reachable

## Requirements

- Obsidian ≥ 1.7.2 (desktop only)
- A running [PaddleX OCR Pipeline](https://paddlepaddle.github.io/PaddleX/latest/pipeline_usage/tutorials/ocr_pipelines/OCR.html) server exposing a `POST /ocr` HTTP endpoint

### Quick server start (Docker)

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
# 1. Clone the repo
git clone https://github.com/Nexround/obsidian-ocr-image.git
cd obsidian-ocr-image

# 2. Install dependencies
npm install

# 3. Build and deploy to your vault
VAULT="/path/to/your/vault"
npm run build
mkdir -p "$VAULT/.obsidian/plugins/ocr-image"
cp main.js manifest.json styles.css "$VAULT/.obsidian/plugins/ocr-image/"
```

### Enable in Obsidian

1. **Settings → Community Plugins** — turn off *Restricted mode*
2. Find **OCR Images** in the plugin list and toggle it **on**
3. Go to **Settings → OCR Images** and set your API URL

## Usage

Open any note that contains images, then run the command palette (`Cmd/Ctrl+P`) and choose:

> **OCR Images in Current Note**

The plugin will process each image sequentially and insert the recognized text immediately below it.

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

| Setting | Default | Description |
|---------|---------|-------------|
| **API URL** | `http://localhost:8080/ocr` | Full URL of the PaddleX OCR endpoint |
| **Output format** | Callout | `> [!note]+` callout or ` ```ocr ` fenced block |
| **Skip already-processed** | On | Don't re-OCR images that already have a block below them |
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
npm run deploy   # build + copy to vault (path hardcoded in package.json)
```

The source is a single TypeScript file: `src/main.ts`.

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
        "texts": ["line 1", "line 2"],
        "scores": [0.98, 0.95]
      }
    }]
  }
}
```

Full API documentation: [`ocr.md`](https://github.com/Nexround/obsidian-ocr-image/blob/main/ocr.md) *(not included in this repo — see the PaddleX serving docs)*

## License

MIT
