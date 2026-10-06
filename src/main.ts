import {
  App,
  Editor,
  FileSystemAdapter,
  MarkdownView,
  Notice,
  Plugin,
  TFile,
} from "obsidian";

import {
  isRuntimeInstalled,
  prependPluginModulePath,
} from "./native-manager";
import { LocalOcrEngine, type ModelTier } from "./local-ocr";
import { NativeOcrEngine } from "./native-ocr";
import type { OcrEngine, OcrItemResult } from "./ocr-engine";
import { OcrImageSettingTab } from "./settings";
import * as path from "path";

// ── Settings ──────────────────────────────────────────────────────────────────

interface OcrImageSettings {
  ocrSource: "paddle" | "native";
  nativeLanguage: string;
  // Local OCR settings
  localModelTier: ModelTier;
  // Output
  outputFormat: "callout" | "codeblock";
  skipAlreadyProcessed: boolean;
  // Concurrency
  maxConcurrency: number;
  // Post-processing
  useTextRefinement: boolean;
  // Developer
  devMode: boolean;
}

const DEFAULT_SETTINGS: OcrImageSettings = {
  ocrSource: "paddle",
  nativeLanguage: "auto",
  localModelTier: "small",
  outputFormat: "callout",
  skipAlreadyProcessed: true,
  maxConcurrency: 3,
  useTextRefinement: true,
  devMode: false,
};

// ── Image match ───────────────────────────────────────────────────────────────

interface ImageMatch {
  fullMatch: string; // entire matched markdown image token
  src: string;       // filename (wikilink) or path/URL (standard md)
  isUrl: boolean;    // true → pass src directly as URL; false → read from vault
  index: number;     // byte offset in document content
}

// Supported image extensions
const IMG_EXT = "png|jpg|jpeg|gif|webp|bmp|svg|tif|tiff|avif|heic|heif";

// Pattern 1: Obsidian wikilink  ![[name.png]]  or  ![[name.png|alt]]
const WIKILINK_IMG_RE = new RegExp(
  `!\\[\\[([^\\]|]+?\\.(${IMG_EXT}))(?:\\|[^\\]]*)?\\]\\]`,
  "gi"
);

// Pattern 2: Standard markdown  ![alt](path.png)  or  ![alt](https://...)
const MARKDOWN_IMG_RE = new RegExp(
  `!\\[([^\\]]*)\\]\\(([^)]+?\\.(${IMG_EXT})(?:\\?[^)]*)?)\\)`,
  "gi"
);

function extractImages(content: string): ImageMatch[] {
  const matches: ImageMatch[] = [];

  // Reset regex state
  WIKILINK_IMG_RE.lastIndex = 0;
  MARKDOWN_IMG_RE.lastIndex = 0;

  let m: RegExpExecArray | null;

  while ((m = WIKILINK_IMG_RE.exec(content)) !== null) {
    matches.push({
      fullMatch: m[0],
      src: m[1].trim(),
      isUrl: false,
      index: m.index,
    });
  }

  while ((m = MARKDOWN_IMG_RE.exec(content)) !== null) {
    const src = m[2].trim();
    matches.push({
      fullMatch: m[0],
      src,
      isUrl: /^https?:\/\//i.test(src),
      index: m.index,
    });
  }

  // Sort by position ascending
  matches.sort((a, b) => a.index - b.index);
  return matches;
}

/**
 * Resolve a vault image reference and return its binary content.
 * Tries three strategies in order: exact vault path, metadataCache wikilink
 * resolution, and vault-wide basename search.
 */
async function fileToArrayBuffer(app: App, imageSrc: string, activeFile: TFile): Promise<ArrayBuffer> {
  let file: TFile | null = null;

  // Strategy 1: exact vault path
  const exact = app.vault.getAbstractFileByPath(imageSrc);
  if (exact instanceof TFile) file = exact;

  // Strategy 2: Obsidian wikilink resolution via metadataCache
  if (!file) {
    const resolved = app.metadataCache.getFirstLinkpathDest(imageSrc, activeFile.path);
    if (resolved instanceof TFile) file = resolved;
  }

  // Strategy 3: vault-wide basename search — used only when the exact path and
  // metadataCache lookup both fail (e.g. broken wikilink or non-indexed file).
  // getFiles() is O(n) over the vault; acceptable here because this branch is
  // rarely hit and there is no API to search by basename alone.
  if (!file) {
    const basename = imageSrc.split("/").pop() ?? imageSrc;
    const allFiles = app.vault.getFiles();
    file =
      allFiles.find(
        (f) => f.name === basename || f.path.endsWith("/" + imageSrc) || f.path === imageSrc
      ) ?? null;
  }

  if (!file) {
    throw new Error(`Image file not found in vault: ${imageSrc}`);
  }

  // Use window.fetch with the Electron app:// resource path so the request is
  // served by Electron's main-process protocol handler. This bypasses macOS
  // sandbox restrictions on quarantined files (com.apple.provenance) that would
  // cause fs.readFile (used by vault.readBinary) to fail with EPERM.
  const resourcePath = app.vault.getResourcePath(file);
  const resp = await window.fetch(resourcePath);
  if (!resp.ok) {
    throw new Error(`Failed to fetch image (${resp.status} ${resp.statusText}): ${resourcePath}`);
  }
  return resp.arrayBuffer();
}
// ── Line-break refinement ─────────────────────────────────────────────────────

/** Sentence-ending punctuation (Chinese + English) */
const SENT_END_RE = /[。！？…；!?]$/;
/** English hyphenated line-break */
const HYPHEN_END_RE = /-$/;
/** List / numbered-item starters that must always begin on their own line */
const LIST_START_RE = /^(?:\d+[.、。）)]\s|[①②③④⑤⑥⑦⑧⑨⑩]\s?|[•·▪▸\-*]\s)/;

/**
 * Merge OCR text lines that are visual soft-wraps into natural prose lines.
 *
 * Merge decision (for two adjacent non-empty lines A → B):
 *  - A ends with sentence-terminating punctuation → hard break, keep.
 *  - B looks like a list item → hard break, keep.
 *  - A ends with "-" → English hyphenated wrap: strip hyphen and join directly.
 *  - Both sides are ASCII word characters at the join point → join with a space.
 *  - Otherwise (CJK content) → join directly, no space.
 */
function refineLineBreaks(texts: string[]): string[] {
  if (texts.length <= 1) return texts;

  const out: string[] = [];
  let buf = "";

  for (const line of texts) {
    // Hard paragraph boundary — flush current buffer, emit the marker
    if (line === "") {
      if (buf !== "") { out.push(buf); buf = ""; }
      out.push("");
      continue;
    }

    // Start a new buffer
    if (buf === "") {
      buf = line;
      continue;
    }

    const shouldMerge =
      !SENT_END_RE.test(buf) &&
      !LIST_START_RE.test(line);

    if (shouldMerge) {
      if (HYPHEN_END_RE.test(buf)) {
        // Drop the hyphen and join
        buf = buf.slice(0, -1) + line;
      } else {
        // Insert a space only when both join sides are ASCII word characters
        const needsSpace =
          /[a-zA-Z0-9]$/.test(buf) && /^[a-zA-Z0-9]/.test(line);
        buf = buf + (needsSpace ? " " : "") + line;
      }
    } else {
      out.push(buf);
      buf = line;
    }
  }

  if (buf !== "") out.push(buf);
  return out;
}

// ── Output formatting ─────────────────────────────────────────────────────────

function formatOcrText(
  texts: string[],
  format: "callout" | "codeblock",
  imageSrc: string
): string {
  if (texts.length === 0) return "";
  const joined = texts.join("\n");
  const filename = imageSrc.split("/").pop() ?? imageSrc;

  if (format === "callout") {
    const contentLines = joined
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    return `\n> [!note]+ OCR: ${filename}\n${contentLines}\n`;
  } else {
    return `\n\`\`\`ocr\n${joined}\n\`\`\`\n`;
  }
}

// ── Already-processed check & removal ────────────────────────────────────────

function isAlreadyProcessed(content: string, insertPos: number): boolean {
  const region = content.slice(insertPos, insertPos + 200);
  return (
    /\n\s*>\s*\[!note\]\+\s*OCR:/i.test(region) ||
    /\n\s*```ocr\n/.test(region)
  );
}

function removeOcrBlock(content: string, insertPos: number): string {
  const tail = content.slice(insertPos);

  const callout = tail.match(/^\n>[^\n]*(?:\n>[^\n]*)*\n/);
  if (callout) {
    return content.slice(0, insertPos) + tail.slice(callout[0].length);
  }

  const codeblock = tail.match(/^\n```ocr\n[\s\S]*?\n```\n/);
  if (codeblock) {
    return content.slice(0, insertPos) + tail.slice(codeblock[0].length);
  }

  return content;
}

// ── Main processing ───────────────────────────────────────────────────────────

interface OcrTaskResult {
  img: ImageMatch;
  texts: string[] | null;
  skipped: boolean;
  error: Error | null;
}

async function processNote(
  app: App,
  plugin: OcrImagePlugin,
  editor: Editor,
  activeFile: TFile
): Promise<void> {
  const content = editor.getValue();
  const images = extractImages(content);

  if (images.length === 0) {
    new Notice("TextLens: no images found in current note.");
    return;
  }

  const isRerun = images.some(
    (img) => isAlreadyProcessed(content, img.index + img.fullMatch.length)
  );

  const label = isRerun ? "Re-OCR" : "OCR";
  const notice = new Notice(`${label}: 0 / ${images.length} done…`, 0);
  try {

    // ── Phase 1: Read all image buffers in parallel (I/O, not model inference) ──

    const bufferSettled = await Promise.allSettled(
      images.map((img) =>
        img.isUrl
          ? Promise.reject(new Error("URL images are not supported in local-only mode"))
          : fileToArrayBuffer(app, img.src, activeFile)
      )
    );
    if (plugin.unloaded) return;

    // Determine which images need to go through the model.
    // Build a dense toProcess array and a globalIndex → localIndex map so Phase 3
    // can look up results without an O(n) search.
    const toProcess: number[] = [];
    const globalToLocal = new Map<number, number>();
    for (let i = 0; i < images.length; i++) {
      const insertPos = images[i].index + images[i].fullMatch.length;
      if (!isRerun && plugin.settings.skipAlreadyProcessed && isAlreadyProcessed(content, insertPos)) {
        continue; // will be recorded as skipped in Phase 3
      }
      if (bufferSettled[i].status === "rejected") {
        continue; // I/O failure; will be recorded as error in Phase 3
      }
      globalToLocal.set(i, toProcess.length);
      toProcess.push(i);
    }

    // ── Phase 2: True batch model inference ────────────────────────────────────

    // Each engine preserves input order and reports progress through this interface.
    let batchResults: OcrItemResult[] = [];

    if (toProcess.length > 0) {
      const batchBuffers = toProcess.map(
        (i) => (bufferSettled[i] as PromiseFulfilledResult<ArrayBuffer>).value
      );
      batchResults = await plugin.engine.batchRecognize(
        batchBuffers,
        plugin.settings.maxConcurrency,
        (batchDone, batchTotal) => {
          notice.setMessage(
            `${label}: ${batchDone} / ${batchTotal ?? toProcess.length} done…`
          );
        }
      );
    }

    // ── Phase 3: Map batch results back to per-image OcrTaskResult[] ────────────

    const results: OcrTaskResult[] = images.map((img, i) => {
      const insertPos = img.index + img.fullMatch.length;

      // Already-processed skip
      if (!isRerun && plugin.settings.skipAlreadyProcessed && isAlreadyProcessed(content, insertPos)) {
        return { img, texts: null, skipped: true, error: null };
      }

      // I/O failure (buffer read failed)
      const bufResult = bufferSettled[i];
      if (bufResult.status === "rejected") {
        const err =
          bufResult.reason instanceof Error
            ? bufResult.reason
            : new Error(String(bufResult.reason));
        console.error(`[text-lens] I/O failed for "${img.src}":`, err);
        return { img, texts: null, skipped: false, error: err };
      }

      // Look up this image's batch result
      const localIdx = globalToLocal.get(i)!;
      const batchItem = batchResults[localIdx];

      if (!batchItem || batchItem.status === "rejected") {
        const reason =
          batchItem?.status === "rejected" ? batchItem.reason : new Error("No batch result");
        const err = reason instanceof Error ? reason : new Error(String(reason));
        console.error(`[text-lens] OCR failed for "${img.src}":`, err);
        return { img, texts: null, skipped: false, error: err };
      }

      const rawTexts = batchItem.value;

      if (plugin.settings.devMode) {
        console.log(`[text-lens] ${img.src.split("/").pop()} raw:`, batchItem.rawLines ?? rawTexts);
      }

      if (rawTexts.length === 0) {
        return { img, texts: null, skipped: false, error: new Error("OCR returned no text") };
      }

      const texts = plugin.settings.useTextRefinement
        ? refineLineBreaks(rawTexts)
        : rawTexts;

      if (plugin.settings.devMode && plugin.settings.useTextRefinement) {
        console.log(`[text-lens] ${img.src.split("/").pop()} refined:`, texts);
      }

      return { img, texts, skipped: false, error: null };
    });

    // ── Write results back into the document ───────────────────────────────────

    let workingContent = content;
    for (const { img, texts } of [...results].sort((a, b) => b.img.index - a.img.index)) {
      if (!texts) continue;
      const insertPos = img.index + img.fullMatch.length;
      if (isRerun) workingContent = removeOcrBlock(workingContent, insertPos);
      const insertion = formatOcrText(texts, plugin.settings.outputFormat, img.src);
      workingContent =
        workingContent.slice(0, insertPos) + insertion + workingContent.slice(insertPos);
    }

    if (plugin.unloaded) return;
    if (editor.getValue() !== content || app.workspace.getActiveViewOfType(MarkdownView)?.file !== activeFile) {
      new Notice("OCR finished, but the note changed or was closed. Run OCR again to insert results safely.", 8000);
      return;
    }
    // A single editor transaction creates one undo entry.
    if (workingContent !== content) editor.transaction({ changes: [{ from: { line: 0, ch: 0 }, to: editor.offsetToPos(content.length), text: workingContent }] });

    const resized = batchResults.flatMap((item) => item.status === "fulfilled" && item.resized ? [images[toProcess[item.index]].src] : []);
    if (resized.length) new Notice(`OCR scaled oversized images to the system limit:\n${resized.join("\n")}`, 10000);

    notice.hide();
    const errors = results.filter((r) => r.error).length;
    if (errors > 0) {
      new Notice(
        `OCR complete: ${results.length - errors} succeeded, ${errors} failed. Check console for details.`,
        6000
      );
    } else {
      new Notice(`OCR complete: ${results.length} image(s) processed.`, 4000);
    }
  } finally { notice.hide(); }
}

// Plugin lifecycle and command dispatch

export default class OcrImagePlugin extends Plugin {
  settings!: OcrImageSettings;
  engine!: OcrEngine;
  busy = false;
  unloaded = false;
  readonly lifetime = new AbortController();
  private settingTab!: OcrImageSettingTab;

  async onload() {
    await this.loadSettings();
    prependPluginModulePath(this.getPluginDir());
    this.engine = this.createEngine();
    if (this.settings.ocrSource === "paddle" && isRuntimeInstalled(this.getPluginDir())) {
      void this.engine.initialize().catch((error) => console.error("[text-lens] Background engine init failed:", error));
    }
    this.settingTab = new OcrImageSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.addCommand({
      id: "ocr-current-note",
      name: "OCR Current Note",
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        const activeFile = view.file;
        if (!activeFile) { new Notice("TextLens: no active file."); return; }
        if (!this.beginWork()) return;
        let initNotice: Notice | undefined;
        try {
          if (this.settings.ocrSource === "paddle" && !isRuntimeInstalled(this.getPluginDir())) {
            new Notice('PaddleOCR runtime is not installed. Open Settings ? TextLens and click "Setup".', 8000);
            return;
          }
          if (!this.engine.ready) {
            initNotice = new Notice("OCR: loading selected engine?", 0);
            await this.engine.initialize();
            initNotice.hide();
          }
          if (!this.unloaded) await processNote(this.app, this, editor, activeFile);
        } catch (error) {
          console.error("[text-lens] OCR failed:", error);
          if (!this.unloaded) new Notice("OCR failed: " + (error instanceof Error ? error.message : String(error)), 10000);
        } finally {
          initNotice?.hide();
          this.endWork();
        }
      },
    });
  }

  beginWork(): boolean {
    if (this.unloaded) return false;
    if (this.busy) { new Notice("TextLens is already working. Wait for the current operation to finish."); return false; }
    this.busy = true;
    this.settingTab?.display();
    return true;
  }

  endWork(): void {
    this.busy = false;
    if (!this.unloaded) this.settingTab?.display();
  }

  onunload() {
    this.unloaded = true;
    this.lifetime.abort();
    void this.engine?.destroy().catch((error: unknown) => console.error("[text-lens] Engine cleanup failed:", error));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<OcrImageSettings>);
    if (this.settings.ocrSource !== "native") this.settings.ocrSource = "paddle";
    if (typeof this.settings.nativeLanguage !== "string" || !this.settings.nativeLanguage) this.settings.nativeLanguage = "auto";
  }

  async saveSettings() { await this.saveData(this.settings); }

  private createEngine(): OcrEngine {
    const pluginDir = this.getPluginDir();
    return this.settings.ocrSource === "native"
      ? new NativeOcrEngine({ pluginDir, version: this.manifest.version, language: this.settings.nativeLanguage, verbose: this.settings.devMode })
      : new LocalOcrEngine({ pluginDir, modelTier: this.settings.localModelTier, verbose: this.settings.devMode });
  }

  async resetEngine(): Promise<void> {
    await this.engine?.destroy();
    if (!this.unloaded) this.engine = this.createEngine();
  }

  getPluginDir(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error("TextLens requires a desktop filesystem vault");
    return path.join(adapter.getBasePath(), this.app.vault.configDir, "plugins", this.manifest.id);
  }
}
