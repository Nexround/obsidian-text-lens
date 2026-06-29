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
  // Output
  outputFormat: "callout" | "codeblock";
  skipAlreadyProcessed: boolean;
  // Concurrency
  maxConcurrency: number;
  // Post-processing
  useTextRefinement: boolean;
  // OCR enhancement toggles (remote only)
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
  maxConcurrency: 3,
  useTextRefinement: true,
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
        texts: string[];       // always empty in current server version
        rec_texts: string[];   // actual recognized text lines
        rec_scores?: number[];
        rec_boxes?: number[][];
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

// ── Vault → Buffer / Base64 ───────────────────────────────────────────────────

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

/**
 * Fetch a vault image as an ArrayBuffer.
 * Uses Obsidian's app:// resource protocol so it bypasses macOS sandbox
 * restrictions (e.g. files downloaded by App Store apps like RedNote).
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

  const resourcePath = app.vault.getResourcePath(file);
  const resp = await fetch(resourcePath);
  if (!resp.ok) {
    throw new Error(`Failed to fetch image (${resp.status} ${resp.statusText}): ${resourcePath}`);
  }
  return resp.arrayBuffer();
}

async function fileToBase64(app: App, imageSrc: string, activeFile: TFile): Promise<string> {
  const buf = await fileToArrayBuffer(app, imageSrc, activeFile);
  return arrayBufferToBase64(buf);
}

// ── Spatial layout ────────────────────────────────────────────────────────────

const ROW_OVERLAP_RATIO = 0.6;
/** Gap between rows exceeding this multiple of average row height → paragraph break */
const PARAGRAPH_GAP_RATIO = 1.8;

/** Internal row representation used for layout and paragraph analysis */
interface RowGroup {
  text: string;
  minY: number;
  maxY: number;
}

/**
 * Core layout analysis: cluster individual OCR boxes into visual rows sorted in
 * reading order (top-to-bottom, left-to-right within each row).
 */
function buildRowGroups(texts: string[], boxes: number[][]): RowGroup[] {
  const items = texts.map((text, i) => {
    const [x1, y1, x2, y2] = boxes[i];
    return { text, cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, h: y2 - y1 };
  });

  items.sort((a, b) => a.cy - b.cy);

  const rawRows: (typeof items)[] = [];
  for (const item of items) {
    const row = rawRows.find((r) => {
      const rowCy = r.reduce((s, x) => s + x.cy, 0) / r.length;
      const rowH  = Math.max(...r.map((x) => x.h));
      return Math.abs(item.cy - rowCy) < Math.max(item.h, rowH) * ROW_OVERLAP_RATIO;
    });
    if (row) row.push(item);
    else rawRows.push([item]);
  }

  // Sort rows top-to-bottom, then build RowGroup records
  rawRows.sort((a, b) => {
    const aCy = a.reduce((s, x) => s + x.cy, 0) / a.length;
    const bCy = b.reduce((s, x) => s + x.cy, 0) / b.length;
    return aCy - bCy;
  });

  return rawRows.map((row) => {
    const sorted = [...row].sort((a, b) => a.cx - b.cx);
    return {
      text: sorted.map((x) => x.text).join("  "),
      minY: Math.min(...row.map((x) => x.cy - x.h / 2)),
      maxY: Math.max(...row.map((x) => x.cy + x.h / 2)),
    };
  });
}

/**
 * Group OCR text boxes into reading-order rows using bounding-box coordinates.
 */
function groupTextByRows(texts: string[], boxes: number[][]): string[] {
  if (texts.length === 0) return [];
  if (texts.length !== boxes.length) return texts;
  return buildRowGroups(texts, boxes).map((r) => r.text);
}

/**
 * Like groupTextByRows, but also inserts "" (empty string) between rows whose
 * vertical gap indicates a paragraph break. The empty strings act as hard-break
 * markers consumed by refineLineBreaks().
 */
function groupTextByRowsWithParagraphs(texts: string[], boxes: number[][]): string[] {
  if (texts.length === 0) return [];
  if (texts.length !== boxes.length) return texts;

  const rows = buildRowGroups(texts, boxes);
  if (rows.length === 0) return texts;

  const avgH = rows.reduce((s, r) => s + (r.maxY - r.minY), 0) / rows.length;

  const result: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    result.push(rows[i].text);
    if (i < rows.length - 1) {
      const gap = rows[i + 1].minY - rows[i].maxY;
      if (gap > avgH * PARAGRAPH_GAP_RATIO) result.push(""); // paragraph marker
    }
  }
  return result;
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
 * Empty strings in `texts` are treated as hard paragraph boundaries inserted by
 * groupTextByRowsWithParagraphs() and are preserved so that the final join("\n")
 * produces blank-line paragraph separation in the output.
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

// ── Remote OCR API call ───────────────────────────────────────────────────────

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
  const body: OcrApiRequest = { file: fileOrUrl };

  if (!isUrl) body.fileType = 1;
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
    const texts = ocrResult.prunedResult.rec_texts ?? [];
    const boxes = ocrResult.prunedResult.rec_boxes ?? [];
    return groupTextByRowsWithParagraphs(texts, boxes);
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
  const results: T[] = new Array(thunks.length);
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
    new Notice("OCR Images: no images found in current note.");
    return;
  }

  // If any image already has an OCR block, treat the whole run as a re-run:
  // force-OCR every image and replace existing blocks.
  const isRerun = images.some(
    (img) => isAlreadyProcessed(content, img.index + img.fullMatch.length)
  );

  const label = isRerun ? "Re-OCR" : "OCR";
  const notice = new Notice(`${label}: 0 / ${images.length} done…`, 0);
  let done = 0;

  // ── Phase 1: concurrent OCR calls ────────────────────────────────────────────
  const thunks = images.map((img): (() => Promise<OcrTaskResult>) => async () => {
    const insertPos = img.index + img.fullMatch.length;

    if (!isRerun && plugin.settings.skipAlreadyProcessed && isAlreadyProcessed(content, insertPos)) {
      notice.setMessage(`${label}: ${++done} / ${images.length} done…`);
      return { img, texts: null, skipped: true, error: null };
    }

    try {
      const fileOrUrl = img.isUrl
        ? img.src
        : await fileToBase64(app, img.src, activeFile);

      const rawTexts = await callOcrApi(plugin.settings, fileOrUrl, img.isUrl);
      if (rawTexts.length === 0) throw new Error("OCR returned no text");

      const texts = plugin.settings.useTextRefinement
        ? refineLineBreaks(rawTexts)
        : rawTexts;

      notice.setMessage(`${label}: ${++done} / ${images.length} done…`);
      return { img, texts, skipped: false, error: null };
    } catch (err) {
      console.error(`[ocr-image] Failed for "${img.src}":`, err);
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

  // ── Phase 2: serial insertion in reverse document order ───────────────────────
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
      .setDesc("How many OCR requests to run in parallel (1–10).")
      .addSlider((slider) =>
        slider
          .setLimits(1, 10, 1)
          .setValue(this.plugin.settings.maxConcurrency)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxConcurrency = value;
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
        "Call GET /health on the OCR server to verify connectivity."
      )
      .addButton((btn) =>
        btn
          .setButtonText("Test")
          .setCta()
          .onClick(async () => {
            btn.setButtonText("Testing…").setDisabled(true);
            try {
              // Derive health-check URL from the configured OCR endpoint
              const healthUrl = new URL(this.plugin.settings.apiUrl);
              healthUrl.pathname = "/health";

              const resp = await requestUrl({
                url: healthUrl.toString(),
                method: "GET",
                throw: false,
              });

              const data = resp.json as { errorCode?: number; errorMsg?: string };
              if (resp.status === 200 && data.errorCode === 0) {
                new Notice("✅ Server healthy", 3000);
              } else {
                throw new Error(
                  `HTTP ${resp.status} — errorCode=${data.errorCode ?? "?"}, ${data.errorMsg ?? "unknown"}`
                );
              }
            } catch (err) {
              new Notice(`❌ Health check failed: ${(err as Error).message}`, 6000);
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
