import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

// ppu-paddle-ocr and onnxruntime-node are kept external:
//  - ppu-paddle-ocr is ESM-only and must be resolved at runtime via the plugin's
//    own node_modules (which is created by NativeBinaryManager / deploy script).
//  - onnxruntime-node ships native .node binaries that esbuild cannot bundle.
//  - @napi-rs/* packages contain prebuilt Rust/C++ binaries — also unbundleable.
//  - ppu-ocv depends on @napi-rs/canvas, so it too stays external.
const NATIVE_EXTERNALS = [
  "onnxruntime-node",
  "onnxruntime-common",
  "ppu-paddle-ocr",
  "ppu-ocv",
  "@napi-rs/canvas",
  "@napi-rs/canvas-darwin-arm64",
  "@napi-rs/canvas-darwin-x64",
  "@napi-rs/canvas-win32-x64-msvc",
  "@napi-rs/canvas-win32-arm64-msvc",
  "@napi-rs/canvas-linux-x64-gnu",
  "@napi-rs/canvas-linux-arm64-gnu",
  "@napi-rs/canvas-linux-x64-musl",
  "@napi-rs/canvas-linux-arm64-musl",
  "@techstark/opencv-js",
];

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...NATIVE_EXTERNALS,
    ...builtins,
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
