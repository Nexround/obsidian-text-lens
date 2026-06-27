/**
 * build-bundle.mjs — builds ppu-bundle.cjs in the project root.
 *
 * Used by:
 *   - GitHub Actions release workflow (uploads as a release asset)
 *   - deploy.mjs (inlines the same logic directly for local deploys)
 *
 * Run: node scripts/build-bundle.mjs
 */

import esbuild from "esbuild";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Keep native binaries external — they are deployed separately.
const NATIVE_EXTERNALS = [
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
];

await esbuild.build({
  entryPoints: [path.join(ROOT, "node_modules", "ppu-paddle-ocr", "index.js")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: ["node18"],
  external: NATIVE_EXTERNALS,
  outfile: path.join(ROOT, "ppu-bundle.cjs"),
  minify: true,
  logLevel: "info",
});

console.log("Built ppu-bundle.cjs");
