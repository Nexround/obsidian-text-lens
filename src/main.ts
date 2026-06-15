import {
  App,
  Editor,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  requestUrl,
} from "obsidian";

// ── Settings ──────────────────────────────────────────────────────────────────

interface OcrImageSettings {
  apiUrl: string;
  outputFormat: "callout" | "codeblock";
  skipAlreadyProcessed: boolean;
  // OCR enhancement toggles
  useDocOrientationClassify: boolean;
  useDocUnwarping: boolean;
  useTextlineOrientation: boolean;
  // Detection thresholds — null means omit from request (server default)
  textDetLimitSideLen: number | null;
  textDetLimitType: "min" | "max" | null;
  textDetThresh: number | null;
  textDetBoxThresh: number | null;
  textDetUnclipRatio: number | null;
  textRecScoreThresh: number | null;
}

const DEFAULT_SETTINGS: OcrImageSettings = {
  apiUrl: "http://runyu.wang:6181/ocr",
  outputFormat: "callout",
  skipAlreadyProcessed: true,
  useDocOrientationClassify: false,
  useDocUnwarping: false,
  useTextlineOrientation: false,
  textDetLimitSideLen: null,
  textDetLimitType: null,
  textDetThresh: null,
  textDetBoxThresh: null,
  textDetUnclipRatio: null,
  textRecScoreThresh: null,
};

// ── API types ─────────────────────────────────────────────────────────────────

interface OcrApiRequest {
  file: string;
  fileType?: number;
  useDocOrientationClassify?: boolean;
  useDocUnwarping?: boolean;
  useTextlineOrientation?: boolean;
  textDetLimitSideLen?: number;
  textDetLimitType?: string;
  textDetThresh?: number;
  textDetBoxThresh?: number;
  textDetUnclipRatio?: number;
  textRecScoreThresh?: number;
}

interface OcrApiResponse {
  logId: string;
  errorCode: number;
  errorMsg: string;
  result?: {
    ocrResults: Array<{
      prunedResult: {
        texts: string[];
        scores?: number[];
        boxes?: number[][];
      };
      ocrImage: string | null;
    }>;
    dataInfo: object;
  };
}

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

// ── Vault → Base64 ────────────────────────────────────────────────────────────

/**
 * Convert ArrayBuffer to base64 in 8192-byte chunks to avoid
 * stack overflow on large images when calling btoa with a big string.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(binary);
}

async function fileToBase64(app: App, imageSrc: string, activeFile: TFile): Promise<string> {
  let file: TFile | null = null;

  // Strategy 1: exact vault path
  const exact = app.vault.getAbstractFileByPath(imageSrc);
  if (exact instanceof TFile) {
    file = exact;
  }

  // Strategy 2: Obsidian wikilink resolution via metadataCache
  if (!file) {
    const resolved = app.metadataCache.getFirstLinkpathDest(imageSrc, activeFile.path);
    if (resolved instanceof TFile) {
      file = resolved;
    }
  }

  // Strategy 3: vault-wide basename search
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

  const buffer = await app.vault.readBinary(file);
  return arrayBufferToBase64(buffer);
}

// ── OCR API call ──────────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`OCR request timed out after ${ms / 1000}s`)), ms)
    ),
  ]);
}

async function callOcrApi(
  settings: OcrImageSettings,
  fileOrUrl: string,
  isUrl: boolean
): Promise<string[]> {
  const body: OcrApiRequest = {
    file: fileOrUrl,
  };

  // For base64 uploads, tell the server it's an image (fileType=1)
  if (!isUrl) body.fileType = 1;

  // Append optional params only when non-default
  if (settings.useDocOrientationClassify) body.useDocOrientationClassify = true;
  if (settings.useDocUnwarping) body.useDocUnwarping = true;
  if (settings.useTextlineOrientation) body.useTextlineOrientation = true;
  if (settings.textDetLimitSideLen !== null) body.textDetLimitSideLen = settings.textDetLimitSideLen;
  if (settings.textDetLimitType !== null) body.textDetLimitType = settings.textDetLimitType;
  if (settings.textDetThresh !== null) body.textDetThresh = settings.textDetThresh;
  if (settings.textDetBoxThresh !== null) body.textDetBoxThresh = settings.textDetBoxThresh;
  if (settings.textDetUnclipRatio !== null) body.textDetUnclipRatio = settings.textDetUnclipRatio;
  if (settings.textRecScoreThresh !== null) body.textRecScoreThresh = settings.textRecScoreThresh;

  const fetchPromise = requestUrl({
    url: settings.apiUrl,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    throw: false,
  }).then((resp) => {
    const data: OcrApiResponse = resp.json;
    if (data.errorCode !== 0) {
      throw new Error(`OCR API error ${data.errorCode}: ${data.errorMsg}`);
    }
    const ocrResult = data.result?.ocrResults?.[0];
    if (!ocrResult) return [];
    return ocrResult.prunedResult.texts ?? [];
  });

  return withTimeout(fetchPromise, 60_000);
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

// ── Already-processed check ───────────────────────────────────────────────────

function isAlreadyProcessed(content: string, insertPos: number): boolean {
  // Look at the 200 chars immediately following the image token
  const region = content.slice(insertPos, insertPos + 200);
  return (
    /\n\s*>\s*\[!note\]\+\s*OCR:/i.test(region) ||
    /\n\s*```ocr\n/.test(region)
  );
}

// ── Main processing ───────────────────────────────────────────────────────────

async function processNote(
  app: App,
  plugin: OcrImagePlugin,
  editor: Editor,
  activeFile: TFile
): Promise<void> {
  const content = editor.getValue();
  const images = extractImages(content);

  if (images.length === 0) {
    new Notice("OCR Images: no images found in current note.");
    return;
  }

  const notice = new Notice(`OCR: 0 / ${images.length} images…`, 0);
  let done = 0;
  let errors = 0;

  // Process in reverse document order so that earlier offsets remain valid
  // after each insertion at a later position.
  const reversed = [...images].reverse();
  let workingContent = content;

  for (const img of reversed) {
    const insertPos = img.index + img.fullMatch.length;
    notice.setMessage(`OCR: ${done + 1} / ${images.length} — ${img.src.split("/").pop()}`);

    try {
      // Skip images that already have an OCR block below them
      if (plugin.settings.skipAlreadyProcessed && isAlreadyProcessed(workingContent, insertPos)) {
        done++;
        continue;
      }

      const fileOrUrl = img.isUrl
        ? img.src
        : await fileToBase64(app, img.src, activeFile);

      const texts = await callOcrApi(plugin.settings, fileOrUrl, img.isUrl);

      if (texts.length > 0) {
        const insertion = formatOcrText(texts, plugin.settings.outputFormat, img.src);
        workingContent =
          workingContent.slice(0, insertPos) + insertion + workingContent.slice(insertPos);
      }

      done++;
    } catch (err) {
      console.error(`[ocr-image] Failed for "${img.src}":`, err);
      errors++;
      done++;
    }
  }

  // Apply all changes in one operation → single undo history entry
  editor.setValue(workingContent);

  notice.hide();
  if (errors > 0) {
    new Notice(`OCR complete: ${done - errors} succeeded, ${errors} failed. Check console for details.`, 6000);
  } else {
    new Notice(`OCR complete: ${done} image(s) processed.`, 4000);
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

    containerEl.createEl("h2", { text: "OCR Images" });

    // ── Core settings ─────────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("API URL")
      .setDesc("Full URL of the PaddleX OCR endpoint (POST /ocr).")
      .addText((text) =>
        text
          .setPlaceholder("http://runyu.wang:6181/ocr")
          .setValue(this.plugin.settings.apiUrl)
          .onChange(async (value) => {
            this.plugin.settings.apiUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

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

    // ── Enhancement options ───────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Enhancement Options" });

    new Setting(containerEl)
      .setName("Document orientation classify")
      .setDesc("Auto-detect and correct document rotation (useDocOrientationClassify).")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.useDocOrientationClassify)
          .onChange(async (value) => {
            this.plugin.settings.useDocOrientationClassify = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Document unwarping")
      .setDesc("Correct perspective distortion for scanned documents (useDocUnwarping).")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.useDocUnwarping).onChange(async (value) => {
          this.plugin.settings.useDocUnwarping = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Text line orientation")
      .setDesc("Classify orientation of individual text lines (useTextlineOrientation).")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.useTextlineOrientation)
          .onChange(async (value) => {
            this.plugin.settings.useTextlineOrientation = value;
            await this.plugin.saveSettings();
          })
      );

    // ── Detection thresholds ──────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Detection Thresholds" });
    containerEl.createEl("p", {
      text: "Leave blank to use server defaults.",
      cls: "setting-item-description",
    });

    const numericSetting = (
      name: string,
      desc: string,
      key: keyof OcrImageSettings,
      placeholder: string
    ) => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((text) =>
          text
            .setPlaceholder(placeholder)
            .setValue(
              this.plugin.settings[key] !== null ? String(this.plugin.settings[key]) : ""
            )
            .onChange(async (raw) => {
              const trimmed = raw.trim();
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (this.plugin.settings as any)[key] =
                trimmed === "" ? null : parseFloat(trimmed);
              await this.plugin.saveSettings();
            })
        );
    };

    numericSetting(
      "Pixel detection threshold",
      "textDetThresh — probability threshold for each pixel to be text (e.g. 0.3).",
      "textDetThresh",
      "0.3"
    );
    numericSetting(
      "Box detection threshold",
      "textDetBoxThresh — confidence threshold for detected text boxes (e.g. 0.6).",
      "textDetBoxThresh",
      "0.6"
    );
    numericSetting(
      "Unclip ratio",
      "textDetUnclipRatio — expansion factor for text boxes (e.g. 1.6).",
      "textDetUnclipRatio",
      "1.6"
    );
    numericSetting(
      "Recognition score threshold",
      "textRecScoreThresh — minimum confidence to keep a recognition result (e.g. 0.5).",
      "textRecScoreThresh",
      "0.5"
    );
    numericSetting(
      "Detection side length limit",
      "textDetLimitSideLen — max/min side length of image fed into detector (e.g. 960).",
      "textDetLimitSideLen",
      "960"
    );

    new Setting(containerEl)
      .setName("Side length limit type")
      .setDesc("textDetLimitType — whether the limit applies to the min or max side.")
      .addDropdown((drop) =>
        drop
          .addOption("", "Server default")
          .addOption("min", "min")
          .addOption("max", "max")
          .setValue(this.plugin.settings.textDetLimitType ?? "")
          .onChange(async (value) => {
            this.plugin.settings.textDetLimitType =
              value === "" ? null : (value as "min" | "max");
            await this.plugin.saveSettings();
          })
      );

    // ── Test connection ───────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Diagnostics" });

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc(
        "Send a 1×1 white PNG to the OCR server to verify the API URL and connectivity."
      )
      .addButton((btn) =>
        btn
          .setButtonText("Test")
          .setCta()
          .onClick(async () => {
            btn.setButtonText("Testing…").setDisabled(true);
            try {
              // Minimal 1×1 white PNG (valid PNG, ~70 bytes)
              const testB64 =
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjE+ibYAAAAASUVORK5CYII=";
              await callOcrApi(this.plugin.settings, testB64, false);
              new Notice("✅ OCR connection test: SUCCESS", 3000);
            } catch (err) {
              new Notice(`❌ OCR connection test FAILED: ${(err as Error).message}`, 6000);
            } finally {
              btn.setButtonText("Test").setDisabled(false);
            }
          })
      );
  }
}

// ── Plugin class ──────────────────────────────────────────────────────────────

export default class OcrImagePlugin extends Plugin {
  settings!: OcrImageSettings;

  async onload() {
    await this.loadSettings();

    this.addSettingTab(new OcrImageSettingTab(this.app, this));

    this.addCommand({
      id: "ocr-images-in-current-note",
      name: "OCR Images in Current Note",
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        const activeFile = view.file;
        if (!activeFile) {
          new Notice("OCR Images: no active file.");
          return;
        }
        await processNote(this.app, this, editor, activeFile);
      },
    });
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
