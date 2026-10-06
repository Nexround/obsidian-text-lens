import { spawn, type ChildProcessWithoutNullStreams } from "child_process";

export interface NativeCommand { executable: string; args: string[] }

/** One outstanding JSONL request at a time. Any transport failure is terminal. */
export class NativeProcess {
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private diagnostics = "";
  private failure: Error | null = null;
  private pending?: { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
  private readonly closed: Promise<void>;

  constructor(command: NativeCommand, private verbose = false) {
    this.child = spawn(command.executable, command.args, { windowsHide: true, stdio: "pipe" });
    this.closed = new Promise((resolve) => this.child.once("close", () => resolve()));
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.diagnostics = (this.diagnostics + chunk).slice(-8192);
      if (this.verbose) console.debug("[native-ocr]", chunk.trim());
    });
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 4 * 1024 * 1024) {
        this.abort(new Error("Native OCR protocol exceeded the output limit"));
        return;
      }
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) { this.abort(new Error("Native OCR returned an empty protocol line")); return; }
        try {
          const value: unknown = JSON.parse(line);
          if (!this.pending) throw new Error("Unsolicited native OCR response");
          const pending = this.pending;
          this.pending = undefined;
          clearTimeout(pending.timer);
          pending.resolve(value);
        } catch (error) {
          this.abort(new Error(`Native OCR protocol is invalid: ${String(error)}`));
          return;
        }
      }
    });
    this.child.on("error", (error) => this.abort(new Error(`Cannot start native OCR: ${error.message}`)));
    this.child.stdin.on("error", (error) => this.abort(new Error(`Native OCR input failed: ${error.message}`)));
    this.child.once("close", (code, signal) => {
      this.abort(new Error(`Native OCR exited (${signal ?? code}). ${this.diagnostics.trim()}`));
    });
  }

  request(value: unknown, timeoutMs = 30000): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending) return Promise.reject(new Error("Native OCR already has a pending request"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.abort(new Error("Native OCR timed out after 30 seconds")), timeoutMs);
      this.pending = { resolve, reject, timer };
      this.child.stdin.write(JSON.stringify(value) + "\n", "utf8");
    });
  }

  abort(error = new Error("Native OCR cancelled")): void {
    this.failure ??= error;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(this.failure);
      this.pending = undefined;
    }
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
  }

  /** Wait for process termination before removing its image files (Windows locks). */
  async stop(): Promise<void> {
    this.abort();
    await this.closed;
  }
}

export interface NativeInfo {
  kind: "info";
  version: string;
  languages: string[];
  defaultLanguage: string | null;
  autoDetection: boolean;
  maxImageDimension: number | null;
}

export function parseNativeInfo(value: unknown, version: string): NativeInfo {
  const info = value as NativeInfo;
  if (!info || info.kind !== "info" || typeof info.version !== "string" ||
      !Array.isArray(info.languages) || !info.languages.every((x) => typeof x === "string") ||
      !(info.defaultLanguage === null || typeof info.defaultLanguage === "string") ||
      typeof info.autoDetection !== "boolean" ||
      !(info.maxImageDimension === null || (typeof info.maxImageDimension === "number" && info.maxImageDimension > 0))) {
    throw new Error("Native OCR returned invalid capabilities");
  }
  if (info.version !== version) throw new Error("Native OCR helper version does not match the plugin. Reinstall it in Settings → TextLens.");
  return info;
}
