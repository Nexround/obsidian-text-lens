/**
 * NativeBinaryManager
 *
 * Downloads and installs native binaries for the current platform on first use,
 * storing them inside the plugin's own directory so that Node.js/ESM module
 * resolution finds them without touching the user's system.
 *
 * Layout after setup:
 *
 *   <pluginDir>/
 *     node_modules/
 *       onnxruntime-common/          (JS only, ~1 MB)
 *       onnxruntime-node/
 *         dist/                      (JS only, ~52 KB)
 *         bin/napi-v6/<platform>/<arch>/
 *           onnxruntime_binding.node (~260 KB)
 *           libonnxruntime.*.dylib   (~37 MB, macOS)
 *       @napi-rs/
 *         canvas/                    (JS wrapper, ~148 KB)
 *         canvas-<platform>-<arch>/
 *           skia.<platform>-<arch>.node  (~25 MB, macOS arm64)
 *
 * The onnxruntime-node npm tarball ships all platforms (~258 MB).  We stream-
 * decompress and extract only the current-platform files (~40 MB).
 * The @napi-rs/canvas platform tarball is small and platform-specific (~25 MB).
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";

// ── Constants ─────────────────────────────────────────────────────────────────

const ORT_VERSION = "1.27.0";
const NAPI_CANVAS_VERSION = "1.0.0";

const GITHUB_REPO = "Nexround/obsidian-text-lens";

const ORT_TARBALL_URL =
  `https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-${ORT_VERSION}.tgz`;
const ORT_COMMON_TARBALL_URL =
  `https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-${ORT_VERSION}.tgz`;
const NAPI_CANVAS_TARBALL_URL =
  `https://registry.npmjs.org/@napi-rs/canvas/-/canvas-${NAPI_CANVAS_VERSION}.tgz`;

// @napi-rs/canvas uses a different naming convention for its platform packages:
//   darwin  arm64  → canvas-darwin-arm64
//   darwin  x64    → canvas-darwin-x64
//   win32   x64    → canvas-win32-x64-msvc
//   linux   x64    → canvas-linux-x64-gnu
//   linux   arm64  → canvas-linux-arm64-gnu
function napiCanvasPlatformPkg(platform: string, arch: string): string {
  if (platform === "win32") return `canvas-${platform}-${arch}-msvc`;
  if (platform === "linux") return `canvas-${platform}-${arch}-gnu`;
  return `canvas-${platform}-${arch}`;
}

// ── Minimal tar parser ────────────────────────────────────────────────────────

function parseTar(
  tarBuf: Buffer,
  onFile: (tarPath: string, data: Buffer) => void
): void {
  let offset = 0;

  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;

    const nameRaw = header.subarray(0, 100).toString("ascii").replace(/\0.*$/, "");
    const prefix  = header.subarray(345, 500).toString("ascii").replace(/\0.*$/, "");
    const fullPath = prefix ? `${prefix}/${nameRaw}` : nameRaw;

    const sizeStr = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const size    = parseInt(sizeStr, 8) || 0;
    const typeFlag = String.fromCharCode(header[156]);

    offset += 512;

    if (typeFlag === "0" || typeFlag === "\0") {
      onFile(fullPath, tarBuf.subarray(offset, offset + size));
    }

    offset += Math.ceil(size / 512) * 512;
  }
}

// ── Download helper ───────────────────────────────────────────────────────────

async function fetchBytes(url: string): Promise<Buffer> {
  // `obsidian` is a virtual module injected by Electron — it has no file path,
  // so dynamic import() (which uses the browser ESM resolver) cannot find it.
  // require() uses the CJS resolver which resolves virtual/built-in modules correctly.
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports -- obsidian is a virtual Electron module with no resolvable file path; dynamic import() fails in the app:// renderer context
  const { requestUrl } = require("obsidian") as typeof import("obsidian");
  const resp = await requestUrl({ url, method: "GET", throw: true });
  return Buffer.from(resp.arrayBuffer);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function writeEntry(destRoot: string, tarPath: string, data: Buffer): void {
  const rel  = tarPath.replace(/^package\//, "");
  const dest = path.join(destRoot, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, data);
}

function ortDir(pluginDir: string)       { return path.join(pluginDir, "node_modules", "onnxruntime-node"); }
function ortCommonDir(pluginDir: string) { return path.join(pluginDir, "node_modules", "onnxruntime-common"); }
function napiCanvasDir(pluginDir: string){ return path.join(pluginDir, "node_modules", "@napi-rs", "canvas"); }
function napiCanvasPlatformDir(pluginDir: string, pkg: string) {
  return path.join(pluginDir, "node_modules", "@napi-rs", pkg);
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface DownloadProgress {
  phase: string;
  fraction?: number;
  message: string;
}

export type ProgressCallback = (p: DownloadProgress) => void;

/** True when all required native files and the JS bundle are present. */
export function isRuntimeInstalled(pluginDir: string): boolean {
  const { platform, arch } = process;
  const ortBinding = path.join(
    ortDir(pluginDir), "bin", "napi-v6", platform, arch, "onnxruntime_binding.node"
  );
  const napiPkg = napiCanvasPlatformPkg(platform, arch);
  // The @napi-rs/canvas platform package ships a binary named
  // skia.<platform>-<arch>[suffix].node — without the leading "canvas-" that
  // appears in the npm package name.  For example:
  //   package  @napi-rs/canvas-darwin-arm64  → file  skia.darwin-arm64.node
  //   package  @napi-rs/canvas-linux-x64-gnu → file  skia.linux-x64-gnu.node
  const bindingName = `skia.${napiPkg.replace(/^canvas-/, "")}.node`;
  const napiBinding = path.join(napiCanvasPlatformDir(pluginDir, napiPkg), bindingName);
  const ppuBundle = path.join(pluginDir, "node_modules", "ppu-bundle.cjs");
  return fs.existsSync(ortBinding) && fs.existsSync(napiBinding) && fs.existsSync(ppuBundle);
}

/**
 * Download and install all required native packages into `<pluginDir>/node_modules/`.
 * Safe to call repeatedly — already-present files are skipped.
 *
 * @param pluginVersion  The plugin's semver string (from manifest.json).
 *                       Used to download the matching ppu-bundle.cjs from the GitHub release.
 */
export async function installRuntime(
  pluginDir: string,
  pluginVersion: string,
  onProgress?: ProgressCallback
): Promise<void> {
  const { platform, arch } = process;
  const report = (p: DownloadProgress) => onProgress?.(p);

  // ── 1. onnxruntime-node (platform binaries only) ──────────────────────────

  const ortBinding = path.join(ortDir(pluginDir), "bin", "napi-v6", platform, arch, "onnxruntime_binding.node");
  if (!fs.existsSync(ortBinding)) {
    report({ phase: "download-ort", message: `Downloading onnxruntime-node ${ORT_VERSION}…` });
    const tgz = await fetchBytes(ORT_TARBALL_URL);

    report({ phase: "extract-ort", message: "Extracting onnxruntime-node…" });
    const tar = zlib.gunzipSync(tgz);
    let n = 0;

    parseTar(tar, (tarPath, data) => {
      const rel = tarPath.replace(/^package\//, "");
      if (rel !== "package.json" && !rel.startsWith("dist/") &&
          !rel.startsWith(`bin/napi-v6/${platform}/${arch}/`)) return;
      writeEntry(ortDir(pluginDir), tarPath, data);
      n++;
    });

    if (n === 0) throw new Error(`onnxruntime-node: no files found for ${platform}/${arch}`);
  }

  // ── 2. onnxruntime-common (JS only) ──────────────────────────────────────

  if (!fs.existsSync(path.join(ortCommonDir(pluginDir), "package.json"))) {
    report({ phase: "download-common", message: "Downloading onnxruntime-common…" });
    const tgz = await fetchBytes(ORT_COMMON_TARBALL_URL);

    report({ phase: "extract-common", message: "Extracting onnxruntime-common…" });
    const tar = zlib.gunzipSync(tgz);

    parseTar(tar, (tarPath, data) => {
      const rel = tarPath.replace(/^package\//, "");
      if (rel.startsWith("test/") || rel.startsWith("node_modules/")) return;
      writeEntry(ortCommonDir(pluginDir), tarPath, data);
    });
  }

  // ── 3. @napi-rs/canvas JS wrapper ────────────────────────────────────────

  if (!fs.existsSync(path.join(napiCanvasDir(pluginDir), "package.json"))) {
    report({ phase: "download-canvas", message: "Downloading @napi-rs/canvas…" });
    const tgz = await fetchBytes(NAPI_CANVAS_TARBALL_URL);

    report({ phase: "extract-canvas", message: "Extracting @napi-rs/canvas…" });
    const tar = zlib.gunzipSync(tgz);

    parseTar(tar, (tarPath, data) => {
      const rel = tarPath.replace(/^package\//, "");
      if (rel.startsWith("node_modules/")) return;
      writeEntry(napiCanvasDir(pluginDir), tarPath, data);
    });
  }

  // ── 4. @napi-rs/canvas platform binary ───────────────────────────────────

  const napiPkg  = napiCanvasPlatformPkg(platform, arch);
  const napiPkgDir = napiCanvasPlatformDir(pluginDir, napiPkg);
  // Same naming convention as isRuntimeInstalled: strip leading "canvas-".
  const napiBinding = path.join(napiPkgDir, `skia.${napiPkg.replace(/^canvas-/, "")}.node`);

  if (!fs.existsSync(napiBinding)) {
    const napiPlatformUrl =
      `https://registry.npmjs.org/@napi-rs/${napiPkg}/-/${napiPkg}-${NAPI_CANVAS_VERSION}.tgz`;

    report({ phase: "download-skia", message: `Downloading @napi-rs/${napiPkg} (~25 MB)…` });
    const tgz = await fetchBytes(napiPlatformUrl);

    report({ phase: "extract-skia", message: "Extracting skia native binary…" });
    const tar = zlib.gunzipSync(tgz);

    parseTar(tar, (tarPath, data) => {
      writeEntry(napiPkgDir, tarPath, data);
    });
  }

  // ── 5. ppu-bundle.cjs ────────────────────────────────────────────────────
  // ppu-paddle-ocr is ESM-only and cannot be bundled into main.js. It is
  // pre-built to a CJS file per release and attached as a GitHub Release
  // asset so that require() can load it without hitting Chromium's
  // cross-protocol block on file:// imports from the app:// context.

  const ppuBundle = path.join(pluginDir, "node_modules", "ppu-bundle.cjs");
  if (!fs.existsSync(ppuBundle)) {
    const bundleUrl =
      `https://github.com/${GITHUB_REPO}/releases/download/${pluginVersion}/ppu-bundle.cjs`;
    report({ phase: "download-bundle", message: "Downloading ppu-bundle.cjs…" });
    const buf = await fetchBytes(bundleUrl);
    fs.mkdirSync(path.dirname(ppuBundle), { recursive: true });
    fs.writeFileSync(ppuBundle, buf);
  }

  report({ phase: "done", fraction: 1, message: "Runtime ready." });
}

/**
 * Prepend the plugin's node_modules to Node.js module search path so that
 * CJS require('onnxruntime-node') resolves to our local copy.
 * Call this once at plugin load, before any import of ppu-paddle-ocr.
 */
export function prependPluginModulePath(pluginDir: string): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports -- Node.js built-in 'module' must be loaded via CJS require(); ESM import() of built-ins is unavailable in the Obsidian renderer bundle
  const Module = require("module") as { globalPaths: string[] };
  const dir = path.join(pluginDir, "node_modules");
  if (!Module.globalPaths.includes(dir)) {
    Module.globalPaths.unshift(dir);
  }
}

/**
 * Remove all runtime binaries installed by installRuntime() by deleting the
 * plugin's node_modules directory.  Safe to call even if the directory does
 * not exist.  The user can re-install via installRuntime() at any time.
 */
export async function uninstallRuntime(pluginDir: string): Promise<void> {
  const nmDir = path.join(pluginDir, "node_modules");
  if (fs.existsSync(nmDir)) {
    fs.rmSync(nmDir, { recursive: true, force: true });
  }
}

/**
 * Delete the ppu-paddle-ocr model weight cache stored outside the plugin
 * directory.  Returns whether a cache directory was actually found and
 * deleted, along with its path, so callers can surface the information to
 * the user.
 */
export async function clearModelCache(): Promise<{ deleted: boolean; cachePath: string }> {
  const cachePath = path.join(os.homedir(), ".cache", "ppu-paddle-ocr");
  const deleted = fs.existsSync(cachePath);
  if (deleted) {
    fs.rmSync(cachePath, { recursive: true, force: true });
  }
  return { deleted, cachePath };
}
