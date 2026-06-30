import {
  App,
  Editor,
  FileSystemAdapter,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
} from "obsidian";

import {
  isRuntimeInstalled,
  installRuntime,
  uninstallRuntime,
  clearModelCache,
  prependPluginModulePath,
  type DownloadProgress,
} from "./native-manager";
import { LocalOcrEngine, type ModelTier } from "./local-ocr";

// ── Settings ──────────────────────────────────────────────────────────────────

interface OcrImageSettings {
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
const IMG_EXT = "png|jpg|jpeg|gif|webp|bmp|svg|tiff|avif";

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

// ── OCR dispatch ─────────────────────────────────────────────────────────────

/** Run OCR on a single vault image using the local engine. */
async function runOcr(
  plugin: OcrImagePlugin,
  app: App,
  img: ImageMatch,
  activeFile: TFile
): Promise<string[]> {
  if (img.isUrl) {
    throw new Error("URL images are not supported in local-only mode");
  }
  const buf = await fileToArrayBuffer(app, img.src, activeFile);
  return plugin.localEngine.recognize(buf);
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

// ── Concurrency helper ────────────────────────────────────────────────────────

async function withConcurrency<T>(
  thunks: Array<() => Promise<T>>,
  limit: number
): Promise<T[]> {
  const results: T[] = new Array<T>(thunks.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < thunks.length) {
      const i = next++;
      results[i] = await thunks[i]();
    }
  }

  const slots = Math.min(Math.max(limit, 1), thunks.length);
  await Promise.all(Array.from({ length: slots }, worker));
  return results;
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
  let done = 0;

  const thunks = images.map((img): (() => Promise<OcrTaskResult>) => async () => {
    const insertPos = img.index + img.fullMatch.length;

    if (!isRerun && plugin.settings.skipAlreadyProcessed && isAlreadyProcessed(content, insertPos)) {
      notice.setMessage(`${label}: ${++done} / ${images.length} done…`);
      return { img, texts: null, skipped: true, error: null };
    }

    try {
      const rawTexts = await runOcr(plugin, app, img, activeFile);

      if (plugin.settings.devMode) {
        console.log(`[text-lens] ${img.src.split("/").pop()} raw:`, rawTexts);
      }

      if (rawTexts.length === 0) throw new Error("OCR returned no text");

      const texts = plugin.settings.useTextRefinement
        ? refineLineBreaks(rawTexts)
        : rawTexts;

      if (plugin.settings.devMode && plugin.settings.useTextRefinement) {
        console.log(`[text-lens] ${img.src.split("/").pop()} refined:`, texts);
      }

      notice.setMessage(`${label}: ${++done} / ${images.length} done…`);
      return { img, texts, skipped: false, error: null };
    } catch (err) {
      console.error(`[text-lens] Failed for "${img.src}":`, err);
      notice.setMessage(`${label}: ${++done} / ${images.length} done…`);
      return {
        img,
        texts: null,
        skipped: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  });

  const results = await withConcurrency(thunks, plugin.settings.maxConcurrency);

  let workingContent = content;
  for (const { img, texts } of [...results].sort((a, b) => b.img.index - a.img.index)) {
    if (!texts) continue;
    const insertPos = img.index + img.fullMatch.length;
    if (isRerun) workingContent = removeOcrBlock(workingContent, insertPos);
    const insertion = formatOcrText(texts, plugin.settings.outputFormat, img.src);
    workingContent =
      workingContent.slice(0, insertPos) + insertion + workingContent.slice(insertPos);
  }

  editor.setValue(workingContent);

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
}

// ── Confirmation modal ────────────────────────────────────────────────────────

/** Generic two-button confirmation dialog used for destructive operations. */
class ConfirmModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private body: string,
    private confirmLabel: string,
    private onConfirm: () => void | Promise<void>,
  ) {
    super(app);
  }

  onOpen() {
    this.contentEl.createEl("h3", { text: this.title });
    this.contentEl.createEl("p", { text: this.body });
    new Setting(this.contentEl)
      .addButton((btn) => btn.setButtonText("取消").onClick(() => this.close()))
      .addButton((btn) =>
        btn
          .setButtonText(this.confirmLabel)
          .setDestructive()
          .onClick(() => {
            this.close();
            void this.onConfirm();
          })
      );
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ── Settings tab ──────────────────────────────────────────────────────────────

class OcrImageSettingTab extends PluginSettingTab {
  plugin: OcrImagePlugin;

  constructor(app: App, plugin: OcrImagePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ── Local engine setup ────────────────────────────────────────────────────
    new Setting(containerEl).setName("Local OCR Engine").setHeading();

      const pluginDir = (this.plugin.app.vault.adapter as FileSystemAdapter).basePath +
        `/.obsidian/plugins/${this.plugin.manifest.id}`;
      const installed = isRuntimeInstalled(pluginDir);

      containerEl.createEl("p", {
        cls: "setting-item-description",
        text: installed
          ? this.plugin.localEngine.ready
            ? "✅ Runtime installed — engine loaded and ready."
            : "✅ Runtime installed — engine idle (loads automatically on first OCR run)."
          : "⚠️ Runtime not installed. Click \"Setup\" to download (~40 MB).",
      });

      if (!installed) {
        new Setting(containerEl)
          .setName("Setup local runtime")
          .setDesc("Downloads onnxruntime-node native binaries for your platform.")
          .addButton((btn) =>
            btn
              .setButtonText("Setup")
              .setCta()
              .onClick(async () => {
                btn.setButtonText("Downloading…").setDisabled(true);
                try {
                  await installRuntime(pluginDir, this.plugin.manifest.version, (p: DownloadProgress) => {
                    btn.setButtonText(p.message.slice(0, 30) + "…");
                  });
                  // Prime the module path so subsequent require() finds it
                  prependPluginModulePath(pluginDir);
                  new Notice("Local OCR runtime installed!", 8000);
                  this.display(); // re-render panel to show installed state
                } catch (err) {
                  new Notice(`Setup failed: ${(err as Error).message}`, 8000);
                  console.error("[text-lens] Runtime setup failed:", err);
                  btn.setButtonText("Setup").setDisabled(false);
                }
              })
          );
      }

      new Setting(containerEl)
        .setName("Model tier")
        .setDesc(
          "tiny (~5 MB, fastest), small (~25 MB, balanced, default), medium (~60 MB, most accurate). " +
          "Models are cached at ~/.cache/ppu-paddle-ocr/ after first use."
        )
        .addDropdown((drop) =>
          drop
            .addOption("tiny",   "Tiny (fastest)")
            .addOption("small",  "Small (balanced)")
            .addOption("medium", "Medium (most accurate)")
            .setValue(this.plugin.settings.localModelTier)
            .onChange(async (value) => {
              this.plugin.settings.localModelTier = value as ModelTier;
              await this.plugin.saveSettings();
              // Destroy existing engine so it re-initialises with the new model
              try {
                await this.plugin.resetLocalEngine();
              } catch (err) {
                console.error("[text-lens] Failed to reset local engine after model tier change:", err);
                new Notice(`切换模型失败: ${(err as Error).message}`, 6000);
              }
            })
        );

      if (installed && this.plugin.localEngine.ready) {
        new Setting(containerEl)
          .setName("Unload local engine")
          .setDesc("Free the ~200 MB of ONNX inference session memory.")
          .addButton((btn) =>
            btn.setButtonText("Unload").onClick(async () => {
              try {
                await this.plugin.resetLocalEngine();
                new Notice("Local OCR engine unloaded.", 3000);
              } catch (err) {
                console.error("[text-lens] Failed to unload local engine:", err);
                new Notice(`卸载引擎失败: ${(err as Error).message}`, 6000);
              }
              this.display();
            })
          );
      } else if (installed && !this.plugin.localEngine.ready) {
        new Setting(containerEl)
          .setName("Load local engine")
          .setDesc("Pre-load the ONNX session into memory (also happens automatically on first OCR run).")
          .addButton((btn) =>
            btn
              .setButtonText("Load")
              .onClick(async () => {
                btn.setButtonText("Loading…").setDisabled(true);
                try {
                  await this.plugin.localEngine.initialize();
                  this.display();
                } catch (err) {
                  console.error("[text-lens] Failed to load local engine:", err);
                  new Notice(`加载引擎失败: ${(err as Error).message}`, 6000);
                  btn.setButtonText("Load").setDisabled(false);
                }
              })
          );
      }

      // ── Cleanup ──────────────────────────────────────────────────────────────
      if (installed) {
        new Setting(containerEl)
          .setName("Delete runtime files")
          .setDesc(
            "Remove onnxruntime-node, @napi-rs/canvas and ppu-bundle from the plugin directory (~40 MB). " +
            "The engine will be unloaded first. You can re-install via \"Setup\"."
          )
          .addButton((btn) =>
            btn.setButtonText("Delete").setDestructive().onClick(() => {
              new ConfirmModal(
                this.plugin.app,
                "Delete runtime files?",
                "This will remove ~40 MB of native binaries from the plugin directory. " +
                  "The local engine will be unloaded. You can re-install them at any time via \"Setup\".",
                "Delete",
                async () => {
                  try {
                    await this.plugin.localEngine?.destroy();
                    await uninstallRuntime(pluginDir);
                    new Notice("Runtime files deleted.", 4000);
                  } catch (err) {
                    new Notice(`删除失败: ${(err as Error).message}`, 6000);
                    console.error("[text-lens] Failed to uninstall runtime:", err);
                  }
                  this.display();
                }
              ).open();
            })
          );
      }

      new Setting(containerEl)
        .setName("Clear model cache")
        .setDesc(
          "Delete downloaded model weights from ~/.cache/ppu-paddle-ocr/ (5–60 MB depending on tier). " +
          "Models will be re-downloaded automatically on next OCR run."
        )
        .addButton((btn) =>
          btn.setButtonText("Clear").setDestructive().onClick(() => {
            new ConfirmModal(
              this.plugin.app,
              "Clear model cache?",
              "This will delete cached model weights from ~/.cache/ppu-paddle-ocr/. " +
                "They will be re-downloaded automatically when you next run OCR.",
              "Clear",
              async () => {
                try {
                  const { deleted, cachePath } = await clearModelCache();
                  new Notice(
                    deleted
                      ? `Model cache cleared: ${cachePath}`
                      : "No model cache found.",
                    4000
                  );
                } catch (err) {
                  new Notice(`清除失败: ${(err as Error).message}`, 6000);
                  console.error("[text-lens] Failed to clear model cache:", err);
                }
              }
            ).open();
          })
        );

    // ── Output ────────────────────────────────────────────────────────────────
    new Setting(containerEl).setName("Output").setHeading();

    new Setting(containerEl)
      .setName("Output format")
      .setDesc("How to insert recognized text below each image.")
      .addDropdown((drop) =>
        drop
          .addOption("callout", "Obsidian callout  (> [!note]+ OCR: …)")
          .addOption("codeblock", "Fenced code block  (```ocr)")
          .setValue(this.plugin.settings.outputFormat)
          .onChange(async (value) => {
            this.plugin.settings.outputFormat = value as "callout" | "codeblock";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Skip already-processed images")
      .setDesc("Don't re-run OCR on images that already have an OCR block below them.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.skipAlreadyProcessed).onChange(async (value) => {
          this.plugin.settings.skipAlreadyProcessed = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Merge wrapped lines")
      .setDesc(
        "Automatically join OCR lines that are visual soft-wraps " +
        "(e.g. a paragraph split across image rows). " +
        "Lines ending with sentence punctuation (。！？ etc.) and list items " +
        "are always kept separate."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.useTextRefinement).onChange(async (value) => {
          this.plugin.settings.useTextRefinement = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Max concurrency")
      .setDesc("How many OCR requests to run in parallel (1–20).")
      .addText((text) =>
        text
          .setPlaceholder("3")
          .setValue(String(this.plugin.settings.maxConcurrency))
          .onChange(async (raw) => {
            const n = parseInt(raw, 10);
            if (!Number.isFinite(n)) return;
            this.plugin.settings.maxConcurrency = Math.min(20, Math.max(1, n));
            await this.plugin.saveSettings();
          })
      );

    // ── Diagnostics ───────────────────────────────────────────────────────────
    new Setting(containerEl).setName("Diagnostics").setHeading();

    new Setting(containerEl)
      .setName("Developer mode")
      .setDesc("Log each image's raw OCR result to the browser console (Ctrl+Shift+I).")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.devMode).onChange(async (value) => {
          this.plugin.settings.devMode = value;
          await this.plugin.saveSettings();
        })
      );
  }
}

// ── Plugin class ──────────────────────────────────────────────────────────────

export default class OcrImagePlugin extends Plugin {
  settings!: OcrImageSettings;
  localEngine!: LocalOcrEngine;

  async onload() {
    await this.loadSettings();

    // Determine plugin directory (needed for runtime binary resolution)
    const pluginDir = this.getPluginDir();

    // Register plugin's node_modules into Node.js module search path so that
    // `require('onnxruntime-node')` inside ppu-paddle-ocr finds our local copy.
    prependPluginModulePath(pluginDir);

    // Create local engine (not yet initialised — lazy on first use)
    this.localEngine = new LocalOcrEngine({
      modelTier: this.settings.localModelTier,
      pluginDir,
      verbose: this.settings.devMode,
    });

    // If runtime is already installed, warm up the engine in the background
    // so the first OCR call is fast.
    if (isRuntimeInstalled(pluginDir)) {
      this.localEngine.initialize().catch((err) => {
        console.error("[text-lens] Background engine init failed:", err);
      });
    }

    this.addSettingTab(new OcrImageSettingTab(this.app, this));

    this.addCommand({
      id: "ocr-current-note",
      name: "OCR Current Note",
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        const activeFile = view.file;
        if (!activeFile) {
          new Notice("TextLens: no active file.");
          return;
        }

        // If the engine is not yet initialised, do it now with a user-visible notice.
        if (!this.localEngine.ready) {
          if (!isRuntimeInstalled(pluginDir)) {
            // Runtime binaries are absent — tell the user and abort.  Without
            // this guard the engine stays uninitialised but runOcr() would still
            // call recognize() in "local" mode, throwing a cryptic internal error.
            new Notice(
              "Local OCR runtime is not installed.\n" +
              "Open Settings → TextLens → Local OCR Engine and click \"Setup\".",
              8000
            );
            return;
          }

          const initNotice = new Notice("OCR: loading local engine…", 0);
          let initOk = false;
          try {
            await this.localEngine.initialize();
            initOk = true;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            new Notice(`Local OCR engine failed to load:\n${msg}`, 10000);
            console.error("[text-lens] Engine init failed:", err);
          } finally {
            initNotice.hide();
          }
          if (!initOk) return;
        }

        try {
          await processNote(this.app, this, editor, activeFile);
        } catch (err) {
          console.error("[text-lens] Unexpected error in processNote:", err);
          new Notice(
            `OCR failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
            8000
          );
        }
      },
    });
  }

  onunload() {
    void this.localEngine?.destroy().catch((err: unknown) => {
      console.error("[text-lens] Error during engine cleanup on unload:", err);
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<OcrImageSettings>);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** Destroy and recreate the local engine (e.g. after model tier change). */
  async resetLocalEngine() {
    await this.localEngine?.destroy();
    this.localEngine = new LocalOcrEngine({
      modelTier: this.settings.localModelTier,
      pluginDir: this.getPluginDir(),
      verbose: this.settings.devMode,
    });
  }

  getPluginDir(): string {
    return (this.app.vault.adapter as FileSystemAdapter).basePath +
      `/.obsidian/plugins/${this.manifest.id}`;
  }
}
