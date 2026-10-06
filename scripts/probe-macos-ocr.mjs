// Runs the actual signed Vision binary and installer, including offline reuse.
// --release fetches the matching published assets; otherwise use the local build.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { bytes, loadNativeModules } from "./native-test-utils.mjs";

if (process.platform !== "darwin") throw new Error("This probe requires macOS.");
await mkdir("build", { recursive: true });
const directory = await mkdtemp(path.resolve("build/macos-ocr-"));
let engine;
try {
  const { NativeOcrEngine, installMacHelper, macHelperPath, helperAssetName } = await loadNativeModules(path.join(directory, "modules"));
  const { version } = JSON.parse(await readFile("manifest.json", "utf8"));
  const name = helperAssetName();
  const fromRelease = process.argv.includes("--release");
  let downloads = 0;
  const download = async (url) => {
    downloads++;
    if (fromRelease) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Release download failed (${response.status}): ${url}`);
      return Buffer.from(await response.arrayBuffer());
    }
    return readFile(path.join("build/native", url.endsWith(".sha256") ? name + ".sha256" : name));
  };
  const pluginDir = path.join(directory, "中文 plugin");
  const info = await installMacHelper(pluginDir, version, console.log, download);
  console.log("Capabilities:", JSON.stringify(info));
  const installed = macHelperPath(pluginDir, version);
  const installedBytes = await readFile(installed);
  const installedHash = createHash("sha256").update(installedBytes).digest("hex");
  const beforeOffline = downloads;
  const tempRoot = path.join(directory, "batches");
  await mkdir(tempRoot);
  const options = { pluginDir, version, language: "auto", verbose: true, tempRoot };
  engine = new NativeOcrEngine(options);
  await engine.initialize();
  const english = bytes(await readFile("scripts/fixtures/english.png"));
  const blank = bytes(await readFile("scripts/fixtures/blank.png"));
  const progress = [];
  const output = await engine.batchRecognize([english, bytes("not an image"), blank, english], 20, (done, total) => progress.push([done, total]));
  assert.deepEqual(output.map((x) => x.status), ["fulfilled", "rejected", "fulfilled", "fulfilled"]);
  assert.deepEqual(output.map((x) => x.index), [0, 1, 2, 3]);
  assert.match(output[0].value.join("\n"), /TextLens.*OCR/i);
  assert.match(output[0].value.join("\n"), /Hello world 12345/i);
  assert.deepEqual(output[2].value, []);
  assert.deepEqual(progress, [[1, 4], [2, 4], [3, 4], [4, 4]]);
  assert.deepEqual(await readdir(tempRoot), []);
  const chinese = info.languages.find((x) => x.startsWith("zh-Hans"));
  if (chinese) {
    await engine.destroy();
    engine = new NativeOcrEngine({ ...options, language: chinese });
    await engine.initialize();
    const chineseOutput = await engine.batchRecognize([bytes(await readFile("scripts/fixtures/chinese.png"))], 1);
    assert.equal(chineseOutput[0].status, "fulfilled");
    assert.match(chineseOutput[0].value.join("\n"), /中文识别测试/);
  } else console.log("SKIP: Simplified Chinese is not supported on this macOS version.");
  await engine.destroy();
  engine = new NativeOcrEngine(options);
  await engine.initialize();
  const reused = await engine.batchRecognize([english], 1);
  assert.equal(reused[0].status, "fulfilled");
  assert.equal(downloads, beforeOffline, "recognition and reinitialization must not download anything");
  await engine.destroy();

  // Reinstall failure must leave the already-installed binary unchanged.
  await assert.rejects(installMacHelper(pluginDir, version, undefined,
    async (url) => url.endsWith(".sha256") ? Buffer.from("0".repeat(64)) : installedBytes), /SHA-256/);
  await assert.rejects(installMacHelper(pluginDir, version + "-mismatch", undefined,
    async (url) => url.endsWith(".sha256") ? Buffer.from(`${installedHash}  ${name}\n`) : installedBytes), /version/);
  assert.equal(createHash("sha256").update(await readFile(installed)).digest("hex"), installedHash);
  assert.ok(!(await readdir(path.dirname(installed))).some((name) => name.endsWith(".tmp")));
  await assert.rejects(installMacHelper(pluginDir, version, undefined, async () => { throw new Error("offline fixture"); }), /offline fixture/);
  const missingLanguage = "xx-Missing";
  const unavailable = new NativeOcrEngine({ ...options, language: missingLanguage });
  try { await assert.rejects(unavailable.initialize(), /language is unavailable/); }
  finally { await unavailable.destroy(); }
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(installMacHelper(pluginDir, version, undefined, download, cancelled.signal), /cancelled/);
  console.log(`PASS: actual Vision ${process.arch} recognition, default/available languages, Unicode plugin path, blank/corrupt images, progress, partial failure, checksum/version rejection, atomic install, cancellation, cleanup and offline reuse (${fromRelease ? "Release download" : "local signed build"}).`);
} finally { await engine?.destroy(); await rm(directory, { recursive: true, force: true }); }
