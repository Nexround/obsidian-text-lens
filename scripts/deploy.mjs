/**
 * deploy.mjs — copies built plugin files to the Obsidian vault's plugin directory,
 * including the onnxruntime-node native binaries for the current platform.
 *
 * Run via: npm run deploy
 * (esbuild.config.mjs production build runs first, then this script)
 */

import esbuild from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_SRC = path.resolve(__dirname, "..");
const VAULT_PLUGIN_DIR = "/Users/wangrunyu/Documents/Obsidian Vault/.obsidian/plugins/ocr-image";

const { platform, arch } = process;

// ── Helpers ───────────────────────────────────────────────────────────────────

function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else {
      copy(s, d);
    }
  }
}

// ── ppu CJS bundle ────────────────────────────────────────────────────────────
// ppu-paddle-ocr (and its deps ppu-ocv, opencv-js) are ESM-only. Obsidian's
// renderer loads pages via app://, so Chromium blocks dynamic import() to
// file:// URLs. Pre-bundle everything to a single CJS file so local-ocr.ts
// can load it with require() (Node.js loader, no protocol restriction).

const ppuBundleDest = path.join(VAULT_PLUGIN_DIR, "node_modules", "ppu-bundle.cjs");
fs.mkdirSync(path.dirname(ppuBundleDest), { recursive: true });

await esbuild.build({
  entryPoints: [path.join(PLUGIN_SRC, "node_modules", "ppu-paddle-ocr", "index.js")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: ["node18"],
  // Keep native binaries external — they're loaded separately by onnxruntime
  // and @napi-rs/canvas platform packages already deployed to node_modules/.
  external: [
    "onnxruntime-node",
    "onnxruntime-common",
    "@napi-rs/canvas",
    "@napi-rs/canvas-darwin-arm64",
    "@napi-rs/canvas-darwin-x64",
    "@napi-rs/canvas-win32-x64-msvc",
    "@napi-rs/canvas-win32-arm64-msvc",
    "@napi-rs/canvas-linux-x64-gnu",
    "@napi-rs/canvas-linux-arm64-gnu",
    "@napi-rs/canvas-linux-x64-musl",
    "@napi-rs/canvas-linux-arm64-musl",
  ],
  outfile: ppuBundleDest,
  minify: false,
  logLevel: "silent",
});
console.log("  bundled  ppu-bundle.cjs (ppu-paddle-ocr + ppu-ocv + opencv-js)");

// ── Static files ──────────────────────────────────────────────────────────────

for (const file of ["main.js", "manifest.json", "styles.css"]) {
  const src = path.join(PLUGIN_SRC, file);
  if (fs.existsSync(src)) {
    copy(src, path.join(VAULT_PLUGIN_DIR, file));
    console.log(`  copied  ${file}`);
  }
}

// ── onnxruntime-node (current platform only) ──────────────────────────────────

const ortSrc = path.join(PLUGIN_SRC, "node_modules", "onnxruntime-node");
const ortDest = path.join(VAULT_PLUGIN_DIR, "node_modules", "onnxruntime-node");

// dist/ (JS glue)
copyDir(path.join(ortSrc, "dist"), path.join(ortDest, "dist"));
console.log(`  copied  onnxruntime-node/dist`);

// package.json (required for require() resolution)
copy(path.join(ortSrc, "package.json"), path.join(ortDest, "package.json"));
console.log(`  copied  onnxruntime-node/package.json`);

// Native binaries for current platform
const binSrc = path.join(ortSrc, "bin", "napi-v6", platform, arch);
const binDest = path.join(ortDest, "bin", "napi-v6", platform, arch);
if (fs.existsSync(binSrc)) {
  copyDir(binSrc, binDest);
  console.log(`  copied  onnxruntime-node/bin/napi-v6/${platform}/${arch}/`);
} else {
  console.warn(`  WARN: no native binary found for ${platform}/${arch} in onnxruntime-node`);
}

// ── onnxruntime-common ────────────────────────────────────────────────────────

const commonSrc = path.join(PLUGIN_SRC, "node_modules", "onnxruntime-common");
const commonDest = path.join(VAULT_PLUGIN_DIR, "node_modules", "onnxruntime-common");
copyDir(commonSrc, commonDest);
console.log(`  copied  onnxruntime-common`);

// ── ppu-paddle-ocr ────────────────────────────────────────────────────────────
// ppu-paddle-ocr itself is kept external so it can be require()'d at runtime.
// We copy the compiled JS package (no native deps when canvas-native engine is used).

const ppuSrc = path.join(PLUGIN_SRC, "node_modules", "ppu-paddle-ocr");
const ppuDest = path.join(VAULT_PLUGIN_DIR, "node_modules", "ppu-paddle-ocr");
copyDir(ppuSrc, ppuDest);
console.log(`  copied  ppu-paddle-ocr`);

// ── ppu-ocv ───────────────────────────────────────────────────────────────────
// canvas-native engine of ppu-ocv has no native deps; copy just the JS.

const ppuOcvSrc = path.join(PLUGIN_SRC, "node_modules", "ppu-ocv");
const ppuOcvDest = path.join(VAULT_PLUGIN_DIR, "node_modules", "ppu-ocv");
copyDir(ppuOcvSrc, ppuOcvDest);
console.log(`  copied  ppu-ocv`);

// ── @napi-rs/canvas ───────────────────────────────────────────────────────────
// ppu-ocv/canvas imports @napi-rs/canvas at module load time (top-level export),
// so the .node binary must be present even though we only pass ArrayBuffers.
// Copy the JS wrapper and the current-platform native binary only.

const napiCanvasSrc = path.join(PLUGIN_SRC, "node_modules", "@napi-rs", "canvas");
const napiCanvasDest = path.join(VAULT_PLUGIN_DIR, "node_modules", "@napi-rs", "canvas");
copyDir(napiCanvasSrc, napiCanvasDest);
console.log(`  copied  @napi-rs/canvas`);

// Platform-specific binary package (e.g. @napi-rs/canvas-darwin-arm64)
const napiPlatformPkg = `canvas-${platform}-${arch}`;
const napiPlatformSrc = path.join(PLUGIN_SRC, "node_modules", "@napi-rs", napiPlatformPkg);
const napiPlatformDest = path.join(VAULT_PLUGIN_DIR, "node_modules", "@napi-rs", napiPlatformPkg);
if (fs.existsSync(napiPlatformSrc)) {
  copyDir(napiPlatformSrc, napiPlatformDest);
  console.log(`  copied  @napi-rs/${napiPlatformPkg}`);
} else {
  console.warn(`  WARN: no @napi-rs binary for ${platform}-${arch}`);
}

console.log(`\nDeploy complete → ${VAULT_PLUGIN_DIR}`);
