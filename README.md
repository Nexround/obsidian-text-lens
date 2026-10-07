# TextLens — Obsidian Plugin

An [Obsidian](https://obsidian.md) plugin that scans the active note for image references and inserts recognized text below each image. **PaddleOCR remains the default.** Version 1.4.0 also offers experimental system OCR through Windows.Media.Ocr and macOS Apple Vision. Recognition runs on your device, without a server or API key.

## Features

- **One command** — `TextLens: OCR Current Note` processes every image in the active file
- **Two recognition sources** — PaddleOCR on Windows/macOS/Linux, or experimental system native OCR on Windows/macOS; your images stay on your machine
- **Model tiers** — Tiny (~5 MB, fastest), Small (~25 MB, balanced), Medium (~60 MB, most accurate)
- **Dual syntax support** — handles both Obsidian wikilinks (`![[image.png]]`) and standard Markdown (`![alt](image.png)`)
- **Idempotent** — skips images that already have an OCR block below them (toggle-able)
- **Re-OCR** — running the command again on an already-processed note automatically replaces all existing OCR blocks
- **Two output formats** — collapsible Obsidian callout or plain fenced code block
- **Single undo step** — the entire batch edit is one `Cmd+Z` entry
- **Merge wrapped lines** — automatically joins soft-wrapped OCR lines into natural prose paragraphs

## Requirements

- Obsidian ≥ 1.7.2 (desktop only — Windows, macOS, Linux)
- PaddleOCR: one-time runtime setup (~40 MB) in **Settings → TextLens → Recognition source → PaddleOCR → Setup**. Model weights download on first use; recognition then works offline.
- Windows native OCR: Windows 10 or later with Windows PowerShell 5.1 and a supported installed OCR language. No extra runtime download.
- macOS native OCR: macOS 11+ on arm64 or 10.15+ on x64. Install the matching precompiled helper from settings once, then recognize offline. Users do not need Swift, Xcode or a separate Node installation.
- Linux: use PaddleOCR. System native OCR is unsupported.

## Installation

### Community Plugin (recommended)

1. Open **Settings → Community Plugins** and disable *Restricted mode*
2. Click **Browse**, search for **TextLens**, and install it
3. Enable the plugin, then go to **Settings → TextLens**, keep **PaddleOCR** selected, and click **Setup**

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/Nexround/obsidian-text-lens/releases/latest)
2. Copy them into `<your-vault>/.obsidian/plugins/text-lens/`
3. Reload Obsidian, enable the plugin, then configure your recognition source in settings

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

The plugin reads image buffers in parallel, recognizes them through the selected source, and inserts text below each image in one editor transaction. PaddleOCR uses the configured concurrency; native OCR runs sequentially in one helper process per batch. A failed image keeps its previous OCR block when you rerun a note.

Settings are locked while recognition runs. Unloading the plugin cancels native subprocesses and writeback. If you edit or close the note during recognition, the plugin asks you to rerun instead of overwriting your changes. Engine failures do not change the selected source.

Native OCR tries the system image decoder first, then attempts renderer conversion to PNG if decoding fails. Animated images use their first frame. Damaged images or formats unsupported by both decoders fail individually. Remote image URLs and PDF OCR are outside the current scope.

### System Native OCR (Experimental)

Choose **Settings → TextLens → Recognition source → System native OCR**.

On Windows, initialization writes the embedded PowerShell bridge into the plugin directory and queries installed languages and the image dimension limit. **System default** uses the user's configured languages, without detecting the image language. Install missing OCR language packs through Windows settings, or choose an installed language in TextLens. Oversized images are scaled proportionally, and the batch reports their names. TextLens removes ordinary spaces between Han characters while preserving English word spaces, Han/English boundaries and tabs.

On macOS, click **Install / reinstall native helper**. TextLens downloads the helper and SHA-256 file from the Release matching the plugin version, checks the checksum and embedded version, and installs the executable atomically. A missing or outdated helper requires installation; download or execution errors appear in settings. This flow does not install developer tools or change system security settings. Source builds need a corresponding Release containing helper assets before this download flow can work.

Vision uses accurate recognition with language correction. System default enables language detection on macOS 13+; older systems use the first supported preferred language, falling back to English. Settings show the actual behavior and available languages. TextLens orders single-column results from top to bottom and left to right within a row; complex columns and tables are not reconstructed. See the [Windows decoder documentation](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.imaging.bitmapdecoder) and [Vision language detection documentation](https://developer.apple.com/documentation/vision/vnrecognizetextrequest/automaticallydetectslanguage).

Native OCR remains experimental until its platform acceptance is complete:

| Platform | Verification Status |
|----------|---------------------|
| Windows | The shipped bridge passed real subprocess recognition for English, Chinese, mixed text, Unicode paths, system default, blank/corrupt images, scaling and missing languages. Obsidian acceptance remains pending. |
| macOS arm64/x64 | Both architectures passed helper compilation, ad-hoc signing, real Vision recognition, verified installation and offline reuse in [release preflight CI](https://github.com/Nexround/obsidian-text-lens/actions/runs/37587264266) on macOS 15. Minimum-version Mac testing, Release download testing on Macs without developer tools and Obsidian acceptance remain pending. |

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
| **Recognition source** | PaddleOCR | PaddleOCR or experimental system native OCR; failures never switch sources |
| **Native language** | System default | Installed Windows languages or runtime-supported Vision languages |
| **Install / reinstall native helper** | — | macOS only: matching Release executable and SHA-256 verification |
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
| **Max concurrency** | 3 | PaddleOCR only: images processed in parallel (1–20). Native OCR always uses 1. |

### Diagnostics

| Setting | Default | Description |
|---------|---------|-------------|
| **Developer mode** | Off | Log raw OCR results, including Windows lines before Han-space normalization, to the console (Ctrl+Shift+I) |

## Development

```bash
npm run dev      # watch mode
npm run build    # production build → main.js
npm run typecheck
npm test         # protocol, cancellation, failure and note-writing regression checks
npm run probe:windows  # Windows: actual shipped system OCR bridge
npm run build:helper -- arm64  # Mac: build and ad-hoc sign (use x64 for Intel)
npm run probe:macos           # Mac: real Vision and installer using local build
npm run probe:macos -- --release  # Mac: published helper download, install and offline reuse
```

### Source layout

```
src/
  main.ts           Plugin entry, command, note processing and guarded writeback
  settings.ts       Source-specific settings and install controls
  ocr-engine.ts     Shared engine and input-indexed batch result contracts
  local-ocr.ts      LocalOcrEngine — wraps ppu-paddle-ocr via CJS bundle
  native-manager.ts Runtime installer — downloads onnxruntime-node & @napi-rs/canvas
  native-ocr.ts     Sequential native batches, deadlines, conversion and temp cleanup
  native-process.ts UTF-8 JSON Lines subprocess transport
  native-helper.ts  Embedded Windows bridge and verified macOS installer
  image-conversion.ts Renderer PNG fallback
  native/windows-ocr.ps1 Windows.Media.Ocr bridge embedded in main.js
native/macos/
  main.swift        Apple Vision JSON Lines helper
scripts/
  build-bundle.mjs  Bundles ppu-paddle-ocr + ppu-ocv + opencv-js → ppu-bundle.cjs
  build-macos-helper.mjs Builds, signs and checksums architecture-specific helpers
  deploy.mjs        Builds and copies all artifacts to a local vault for testing
```

### Why `ppu-bundle.cjs`?

Obsidian's Electron renderer loads pages from the `app://` protocol. Chromium treats a dynamic `import("file://…")` as cross-origin and blocks it. `build-bundle.mjs` pre-bundles `ppu-paddle-ocr` into a single CJS file so `local-ocr.ts` can load it with `require()`, which uses Node.js's CJS resolver and has no protocol restriction.

`ppu-bundle.cjs` is not committed to the repository. It is built in CI and attached to each [GitHub Release](https://github.com/Nexround/obsidian-text-lens/releases) as a release asset, then downloaded on-demand by the plugin's **Setup** flow.

Release CI also builds `text-lens-vision-darwin-arm64` (macOS 11 target) and `text-lens-vision-darwin-x64` (10.15 target), ad-hoc signs each binary, runs real Vision/installer checks, and attaches the binaries plus individual `.sha256` files. The Release tag must match `manifest.json`'s version. System native mode does not load the PaddleOCR bundle or runtime.

Before marking a platform available, verify in Obsidian: first initialization, batch progress, source/language locking and switching, rerun, old results retained on failures, one undo step, native execution without PaddleOCR installed, and unload cancellation. On both Mac architectures also run the Release probe on a machine without developer tools and confirm offline reuse. These manual checks remain pending.

## License

MIT
