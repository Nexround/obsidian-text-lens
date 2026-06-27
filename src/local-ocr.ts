/**
 * LocalOcrEngine
 *
 * Wraps ppu-paddle-ocr's PaddleOcrService for use inside an Obsidian plugin.
 *
 * Key design decisions:
 *  - Input is always an ArrayBuffer (image bytes), bypassing any Canvas dependency.
 *    ppu-paddle-ocr's Node entry accepts ArrayBuffer directly in recognize().
 *  - onnxruntime-node is loaded lazily after NativeBinaryManager has ensured the
 *    native binary is present.
 *  - The service is initialised once and reused; destroy() is called on plugin
 *    unload.
 *  - Output mirrors the shape of callOcrApi() — string[] of text lines — so the
 *    rest of main.ts needs no changes.
 */

import type { PaddleOcrService as PaddleOcrServiceType } from "ppu-paddle-ocr";
import { createRequire } from "module";
import * as path from "path";

// ── Types (keep in sync with ppu-paddle-ocr's public API) ─────────────────────

interface OcrLine {
  text: string;
  confidence: number;
}

interface OcrResult {
  text: string;
  lines: OcrLine[][];
  confidence: number;
}

// ── Engine ────────────────────────────────────────────────────────────────────

export type ModelTier = "tiny" | "small" | "medium";

export interface LocalOcrOptions {
  modelTier: ModelTier;
  /** Absolute path to plugin dir, used to resolve locally-stored model files. */
  pluginDir: string;
  verbose: boolean;
}

export class LocalOcrEngine {
  private service: PaddleOcrServiceType | null = null;
  private initPromise: Promise<void> | null = null;
  private readonly options: LocalOcrOptions;

  constructor(options: LocalOcrOptions) {
    this.options = options;
  }

  /** True once initialize() has completed successfully. */
  get ready(): boolean {
    // this.service is only assigned after PaddleOcrService.initialize() resolves,
    // so a non-null value is sufficient to confirm the engine is ready.
    return this.service !== null;
  }

  /**
   * Load the ONNX models and warm up the inference sessions.
   * Safe to call multiple times — concurrent calls share the same in-flight
   * promise; subsequent calls after success are immediate no-ops.
   * If a previous attempt failed, initPromise is reset so the next call retries.
   * Models are downloaded from GitHub LFS on first use and cached at
   * ~/.cache/ppu-paddle-ocr/ by ppu-paddle-ocr's built-in cache layer.
   */
  async initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    // Store reference before any await so concurrent callers share this promise.
    const p = this._doInit().catch((err) => {
      // Reset so the next initialize() call can retry after a transient failure.
      if (this.initPromise === p) this.initPromise = null;
      throw err;
    });
    this.initPromise = p;
    return p;
  }

  private async _doInit(): Promise<void> {
    // ppu-paddle-ocr is ESM-only ("type":"module"). In Obsidian's Electron
    // renderer the page is served from the app:// protocol, so Chromium's
    // module fetcher blocks any dynamic import() that targets a file:// URL
    // (cross-protocol, treated as cross-origin). Node.js's require() has no
    // such restriction and resolves absolute paths directly via the file system.
    //
    // deploy.mjs therefore pre-bundles ppu-paddle-ocr + ppu-ocv + opencv-js
    // into a single CJS file (<pluginDir>/node_modules/ppu-bundle.cjs), keeping
    // only the native binaries (onnxruntime-node, @napi-rs/canvas) external.
    // We load that bundle here via createRequire(), which always uses Node.js's
    // CJS loader regardless of the calling context.
    const bundlePath = path.join(this.options.pluginDir, "node_modules", "ppu-bundle.cjs");
    const bundleReq = createRequire(`${this.options.pluginDir}${path.sep}`);

    const {
      PaddleOcrService,
      V6_TINY_MODEL,
      V6_SMALL_MODEL,
      V6_MEDIUM_MODEL,
    } = bundleReq("./node_modules/ppu-bundle.cjs") as typeof import("ppu-paddle-ocr");

    if (this.options.verbose) {
      console.log("[local-ocr] Loaded ppu-bundle.cjs from:", bundlePath);
    }

    const modelPreset =
      this.options.modelTier === "tiny"  ? V6_TINY_MODEL  :
      this.options.modelTier === "medium" ? V6_MEDIUM_MODEL :
                                            V6_SMALL_MODEL;

    // Assign to a local variable first — this.service is only set once
    // initialization fully succeeds, so `ready` never returns true for a
    // partially-initialised service.
    const svc = new PaddleOcrService({
      model: modelPreset,
      // canvas-native would require browser Canvas APIs which are unavailable
      // in Obsidian's Node.js (main process) context.  Instead we pass raw
      // ArrayBuffers to recognize() which uses CanvasProcessor.prepareCanvas()
      // internally — that path only needs @napi-rs/canvas when the INPUT is not
      // an ArrayBuffer.  Since we always pass an ArrayBuffer, the canvas engine
      // is irrelevant and we leave it at the default ("opencv") while avoiding
      // any actual OpenCV initialisation by not calling ImageProcessor.initRuntime().
      //
      // NOTE: ppu-paddle-ocr v6 with processing.engine = "canvas-native" avoids
      // OpenCV entirely and only needs CanvasProcessor (no native dep) for the
      // ArrayBuffer → ImageData conversion path.  We use that to stay dep-light.
      processing: { engine: "canvas-native" },
      debugging: { verbose: this.options.verbose },
      // Per-box gives best accuracy (~96.6%) at the cost of one inference call
      // per detected region.  For typical note images this is fast enough.
      // Note: we don't set recognition.strategy here because RecognitionOptions
      // requires charactersDictionary (populated internally by initialize()).
      // Instead we pass strategy per-call in recognize().
    });

    if (this.options.verbose) {
      console.log("[local-ocr] Initialising PaddleOcrService with model tier:", this.options.modelTier);
    }

    await svc.initialize();
    // Only expose the service once it is fully ready.
    this.service = svc;

    if (this.options.verbose) {
      console.log("[local-ocr] PaddleOcrService ready.");
    }
  }

  /**
   * Run OCR on raw image bytes.
   * @param imageBuffer  ArrayBuffer containing the image (PNG, JPEG, etc.)
   * @returns            Array of recognised text lines in reading order.
   */
  async recognize(imageBuffer: ArrayBuffer): Promise<string[]> {
    if (!this.service) {
      throw new Error("LocalOcrEngine.initialize() has not been called.");
    }

    const result = await this.service.recognize(imageBuffer, { strategy: "per-box" }) as OcrResult;

    if (!result || !result.lines) return [];

    // result.lines is Line[][], where each Line[] is a row of text boxes.
    // Flatten each row into a single string, then collect all rows.
    const lines: string[] = [];
    for (const row of result.lines) {
      if (!Array.isArray(row)) continue;
      const rowText = row.map((b: OcrLine) => b.text).join("  ").trim();
      if (rowText) lines.push(rowText);
    }

    return lines;
  }

  /** Release ONNX inference sessions. Call from Plugin.onunload(). */
  async destroy(): Promise<void> {
    if (this.service) {
      await this.service.destroy();
      this.service = null;
      this.initPromise = null;
    }
  }
}
