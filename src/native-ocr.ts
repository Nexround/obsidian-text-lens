import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { OcrEngine, OcrItemResult, OcrProgress } from "./ocr-engine";
import { NativeProcess, parseNativeInfo, type NativeCommand, type NativeInfo } from "./native-process";
import { nativeCommand } from "./native-helper";
import { convertImageToPng } from "./image-conversion";

export interface NativeOcrOptions {
  pluginDir: string;
  version: string;
  language: string;
  verbose: boolean;
  /** Test seams also allow the production protocol to be probed without Obsidian. */
  command?: NativeCommand;
  /** Image deadline override for regression checks; production uses 30 seconds. */
  timeoutMs?: number;
  tempRoot?: string;
  convertToPng?: (bytes: ArrayBuffer) => Promise<ArrayBuffer>;
}

// Only ordinary spaces between Han characters are removed. Tabs remain intact.
export function normalizeWindowsLines(lines: string[]): string[] {
  return lines.map((line) => line.replace(/(\p{Script=Han}) +(?=\p{Script=Han})/gu, "$1"));
}

interface NativeImageResponse {
  kind: "result";
  index: number;
  ok: boolean;
  lines?: string[];
  resized?: boolean;
  error?: string;
  code?: string;
}

function parseImageResponse(value: unknown, index: number): NativeImageResponse {
  const response = value as NativeImageResponse;
  if (!response || response.kind !== "result" || response.index !== index || typeof response.ok !== "boolean" ||
      (response.ok && (!Array.isArray(response.lines) || !response.lines.every((x) => typeof x === "string") || typeof response.resized !== "boolean")) ||
      (!response.ok && (typeof response.error !== "string" || typeof response.code !== "string"))) {
    throw new Error("Native OCR returned an invalid image response or input index");
  }
  return response;
}

export class NativeOcrEngine implements OcrEngine {
  info: NativeInfo | null = null;
  private initialized = false;
  private disposed = false;
  private initPromise: Promise<void> | null = null;
  private command?: NativeCommand;
  private sessions = new Set<NativeProcess>();
  private activeBatch?: Promise<OcrItemResult[]>;
  private cancelImage?: () => void;

  constructor(private options: NativeOcrOptions) {}
  get ready(): boolean { return this.initialized && !this.disposed; }

  initialize(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Native OCR cancelled"));
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.probe().catch((error) => { this.initPromise = null; throw error; });
    return this.initPromise;
  }

  private async probe(): Promise<void> {
    this.command = this.options.command ?? await nativeCommand(this.options.pluginDir, this.options.version);
    if (this.disposed) throw new Error("Native OCR cancelled");
    const session = new NativeProcess(this.command, this.options.verbose);
    this.sessions.add(session);
    try {
      this.info = parseNativeInfo(await session.request({ kind: "info" }), this.options.version);
      const language = this.options.language;
      if (language !== "auto" && !this.info.languages.includes(language)) throw new Error(`OCR language is unavailable: ${language}. Install its system language pack or select another language.`);
      if (language === "auto" && !this.info.autoDetection && !this.info.defaultLanguage) throw new Error("No OCR language is available for the system's preferred languages. Install a language pack or select an installed language.");
      if (this.disposed) throw new Error("Native OCR cancelled");
      this.initialized = true;
    } finally {
      await session.stop();
      this.sessions.delete(session);
    }
  }

  batchRecognize(images: ArrayBuffer[], _concurrency: number | "auto", onProgress?: OcrProgress): Promise<OcrItemResult[]> {
    if (!this.ready || !this.command) return Promise.reject(new Error("NativeOcrEngine.initialize() has not completed"));
    if (this.activeBatch) return Promise.reject(new Error("Native OCR is already running"));
    this.activeBatch = this.runBatch(images, onProgress).finally(() => { this.activeBatch = undefined; });
    return this.activeBatch;
  }

  private async runBatch(images: ArrayBuffer[], onProgress?: OcrProgress): Promise<OcrItemResult[]> {
    if (!images.length) return [];
    const results: OcrItemResult[] = [];
    let directory: string | undefined;
    let session: NativeProcess | undefined;
    const complete = (item: OcrItemResult) => { results.push(item); onProgress?.(results.length, images.length); };
    try {
      directory = await fs.mkdtemp(path.join(this.options.tempRoot ?? os.tmpdir(), "text-lens-native-"));
      if (this.disposed) throw new Error("Native OCR cancelled");
      session = new NativeProcess(this.command!, this.options.verbose);
      this.sessions.add(session);
      for (let index = 0; index < images.length; index++) {
        if (this.disposed) throw new Error("Native OCR cancelled");
        let imagePath = path.join(directory, `${index}.image`);
        try { await fs.writeFile(imagePath, Buffer.from(images[index])); }
        catch (error) { complete({ index, status: "rejected", reason: error }); continue; }
        // The deadline includes the optional renderer conversion and second decode.
        const timeoutMs = this.options.timeoutMs ?? 30000;
        const deadline = Date.now() + timeoutMs;
        let expired = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const processImage = async (): Promise<NativeImageResponse> => {
            const recognize = async () => parseImageResponse(await session!.request(
              { kind: "recognize", index, path: imagePath, language: this.options.language }, Math.max(1, deadline - Date.now())
            ), index);
            let response = await recognize();
            if (!response.ok && response.code === "decode") {
              let png: ArrayBuffer;
              try { png = await (this.options.convertToPng ?? convertImageToPng)(images[index]); }
              catch { return { kind: "result", index, ok: false, code: "decode", error: "Image format is unsupported or damaged (system and renderer decoding failed)" }; }
              if (expired || this.disposed) throw new Error("Native OCR cancelled or timed out");
              imagePath = path.join(directory!, `${index}.png`);
              await fs.writeFile(imagePath, Buffer.from(png));
              if (expired || this.disposed) throw new Error("Native OCR cancelled or timed out");
              response = await recognize();
            }
            return response;
          };
          const response = await Promise.race([
            processImage(),
            new Promise<never>((_, reject) => { this.cancelImage = () => {
              expired = true;
              reject(new Error("Native OCR cancelled"));
            }; }),
            new Promise<never>((_, reject) => { timer = setTimeout(() => {
              expired = true;
              const error = new Error("Native OCR timed out after 30 seconds");
              session!.abort(error);
              reject(error);
            }, timeoutMs); }),
          ]);
          if (response.ok) {
            const rawLines = response.lines!;
            complete({ index, status: "fulfilled", value: process.platform === "win32" ? normalizeWindowsLines(rawLines) : rawLines,
              resized: response.resized, ...(this.options.verbose ? { rawLines } : {}) });
          } else {
            complete({ index, status: "rejected", reason: new Error(response.error) });
          }
        } finally { this.cancelImage = undefined; if (timer) clearTimeout(timer); }
      }
    } catch (error) {
      session?.abort(error instanceof Error ? error : new Error(String(error)));
      while (results.length < images.length) complete({ index: results.length, status: "rejected", reason: error });
    } finally {
      if (session) { await session.stop(); this.sessions.delete(session); }
      if (directory) await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    return results;
  }

  async destroy(): Promise<void> {
    this.disposed = true;
    this.initialized = false;
    this.cancelImage?.();
    await Promise.all([...this.sessions].map((session) => session.stop()));
    await this.activeBatch;
    await this.initPromise?.catch(() => {});
  }
}
