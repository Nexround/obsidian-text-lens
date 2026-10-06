import * as fs from "fs/promises";
import * as path from "path";
import { createHash, randomBytes } from "crypto";
import windowsScript from "./native/windows-ocr.ps1";
import { NativeProcess, parseNativeInfo, type NativeCommand, type NativeInfo } from "./native-process";

export function helperAssetName(arch = process.arch): string {
  if (arch !== "arm64" && arch !== "x64") throw new Error(`Native OCR does not support macOS architecture ${arch}`);
  return `text-lens-vision-darwin-${arch}`;
}

export function macHelperPath(pluginDir: string, version: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error("Invalid plugin version");
  return path.join(pluginDir, "native-ocr", `${helperAssetName()}-${version}`);
}

export async function nativeCommand(pluginDir: string, version: string): Promise<NativeCommand> {
  if (process.platform === "win32") {
    const directory = path.join(pluginDir, "native-ocr");
    await fs.mkdir(directory, { recursive: true });
    const digest = createHash("sha256").update(windowsScript).digest("hex").slice(0, 12);
    const scriptPath = path.join(directory, `windows-ocr-${digest}.ps1`);
    const contents = "\ufeff" + windowsScript;
    const existing = await fs.readFile(scriptPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (existing !== contents) {
      const temporary = `${scriptPath}.${randomBytes(6).toString("hex")}.tmp`;
      try { await fs.writeFile(temporary, contents, { encoding: "utf8", flag: "wx" }); await fs.rename(temporary, scriptPath); }
      finally { await fs.rm(temporary, { force: true }); }
    }
    return {
      executable: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Version", version],
    };
  }
  if (process.platform === "darwin") {
    const helper = macHelperPath(pluginDir, version);
    try { await fs.access(helper, fs.constants.X_OK); }
    catch { throw new Error("Native OCR helper is missing or outdated. Install / reinstall it in Settings → TextLens."); }
    return { executable: helper, args: [] };
  }
  throw new Error("System native OCR is not supported on this platform. Select PaddleOCR on Linux.");
}

type FetchBytes = (url: string) => Promise<Buffer>;
async function fetchBytes(url: string): Promise<Buffer> {
  const { requestUrl } = require("obsidian") as typeof import("obsidian");
  const response = await requestUrl({ url, method: "GET", throw: true });
  return Buffer.from(response.arrayBuffer);
}

/** Verify checksum and embedded version before atomically replacing the helper. */
export async function installMacHelper(
  pluginDir: string, version: string, report?: (message: string) => void, download: FetchBytes = fetchBytes,
  signal?: AbortSignal
): Promise<NativeInfo> {
  if (process.platform !== "darwin") throw new Error("The Vision helper is only used on macOS");
  const destination = macHelperPath(pluginDir, version);
  const checkCancelled = () => { if (signal?.aborted) throw new Error("Native helper installation cancelled"); };
  checkCancelled();
  const asset = helperAssetName();
  const base = `https://github.com/Nexround/obsidian-text-lens/releases/download/${version}/${asset}`;
  report?.("Downloading native helper…");
  const bytes = await download(base);
  const checksum = (await download(base + ".sha256")).toString("utf8").trim();
  checkCancelled();
  const expected = checksum.match(/^([a-fA-F0-9]{64})(?:\s+\*?([^\r\n]+))?$/);
  if (!expected || (expected[2] && expected[2] !== asset) ||
      createHash("sha256").update(bytes).digest("hex") !== expected[1].toLowerCase()) {
    throw new Error("Native helper SHA-256 verification failed; no files were installed");
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomBytes(6).toString("hex")}.tmp`;
  let probe: NativeProcess | undefined;
  const cancel = () => probe?.abort(new Error("Native helper installation cancelled"));
  signal?.addEventListener("abort", cancel);
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o755 });
    await fs.chmod(temporary, 0o755);
    checkCancelled();
    report?.("Checking helper version and execution…");
    probe = new NativeProcess({ executable: temporary, args: [] });
    const info = parseNativeInfo(await probe.request({ kind: "info" }), version);
    await probe.stop();
    probe = undefined;
    checkCancelled();
    await fs.rename(temporary, destination);
    return info;
  } catch (error) {
    throw new Error(`Native helper installation failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    signal?.removeEventListener("abort", cancel);
    await probe?.stop();
    await fs.rm(temporary, { force: true });
  }
}
