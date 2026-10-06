// Integration checks use the shipped engine and embedded Windows bridge.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, readdir, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { bytes, loadNativeModules } from "./native-test-utils.mjs";

if (process.platform !== "win32") throw new Error("This probe requires Windows.");
await mkdir("build", { recursive: true });
const directory = await mkdtemp(path.resolve("build/windows-ocr-"));
const execute = promisify(execFile);
const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const commonArgs = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"];
const fixtureDir = path.join(directory, "中文 images");
const generator = String.raw`
param([string]$OutputDir, [int]$Limit)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
[void][IO.Directory]::CreateDirectory($OutputDir)
$font = New-Object Drawing.Font('Microsoft YaHei', 32, [Drawing.FontStyle]::Regular, [Drawing.GraphicsUnit]::Pixel)
function Save-Image([string]$Name, [string[]]$Lines, $Format, [int]$Width = 1200) {
    $image = New-Object Drawing.Bitmap($Width, 320)
    $graphics = [Drawing.Graphics]::FromImage($image)
    try {
        $graphics.Clear([Drawing.Color]::White)
        $graphics.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
        for ($i = 0; $i -lt $Lines.Count; $i++) {
            $graphics.DrawString($Lines[$i], $font, [Drawing.Brushes]::Black, 32, (32 + $i * 70))
        }
        $image.Save((Join-Path $OutputDir $Name), $Format)
    } finally { $graphics.Dispose(); $image.Dispose() }
}
try {
    Save-Image 'english.png' @('TextLens Windows OCR', 'Hello world 12345') ([Drawing.Imaging.ImageFormat]::Png)
    Save-Image '中文测试.png' @('中文识别测试', '你好世界 今天学习系统原生文字识别') ([Drawing.Imaging.ImageFormat]::Png)
    Save-Image 'mixed.jpg' @('系统原生 OCR 测试', 'Hello world 12345') ([Drawing.Imaging.ImageFormat]::Jpeg)
    Save-Image 'blank.png' @() ([Drawing.Imaging.ImageFormat]::Png)
    Save-Image 'large.png' @('TextLens oversized image') ([Drawing.Imaging.ImageFormat]::Png) ($Limit + 100)
} finally { $font.Dispose() }
`;
let engine;
try {
  const { NativeOcrEngine, nativeCommand, NativeProcess } = await loadNativeModules(path.join(directory, "modules"));
  const { version } = JSON.parse(await readFile("manifest.json", "utf8"));
  const options = { pluginDir: path.join(directory, "中文 plugin"), version, language: "auto", verbose: true, tempRoot: path.join(directory, "batches") };
  await mkdir(options.tempRoot);
  engine = new NativeOcrEngine(options);
  await engine.initialize();
  console.log("Capabilities:", JSON.stringify(engine.info));
  const english = engine.info.languages.find((language) => language.startsWith("en-"));
  const chinese = engine.info.languages.find((language) => language.startsWith("zh-Hans"));
  assert.ok(english, "English language pack is required for this integration probe");
  const generatorPath = path.join(directory, "generate.ps1");
  await writeFile(generatorPath, "\ufeff" + generator, "utf8");
  await execute(powershell, [...commonArgs, generatorPath, fixtureDir, String(engine.info.maxImageDimension)], { windowsHide: true, timeout: 30000 });
  await writeFile(path.join(fixtureDir, "corrupt.png"), "This is not an image");
  const run = async (names, language) => {
    await engine.destroy();
    engine = new NativeOcrEngine({ ...options, language });
    await engine.initialize();
    const progress = [];
    const input = await Promise.all(names.map(async (name) => bytes(await readFile(path.join(fixtureDir, name)))));
    const results = await engine.batchRecognize(input, 20, (done, total) => progress.push([done, total]));
    assert.deepEqual(results.map((result) => result.index), names.map((_, index) => index));
    assert.deepEqual(progress, names.map((_, index) => [index + 1, names.length]));
    assert.deepEqual(await readdir(options.tempRoot), [], "temporary images must be cleaned up");
    console.log(JSON.stringify({ names, language, results: results.map((r) => r.status === "fulfilled" ? r : { ...r, reason: String(r.reason) }) }));
    return results;
  };
  const englishResults = await run(["english.png", "corrupt.png", "blank.png", "large.png", "english.png"], english);
  assert.deepEqual(englishResults.map((r) => r.status), ["fulfilled", "rejected", "fulfilled", "fulfilled", "fulfilled"]);
  assert.match(englishResults[0].value.join("\n"), /TextLens.*Windows.*OCR/i);
  assert.match(englishResults[0].value.join("\n"), /Hello world 12345/i);
  assert.deepEqual(englishResults[2].value, []);
  assert.equal(englishResults[3].resized, true);
  if (chinese) {
    const chineseResults = await run(["中文测试.png", "mixed.jpg"], chinese);
    assert.match(chineseResults[0].value.join("\n"), /中文识别测试/);
    assert.match(chineseResults[1].value.join("\n"), /Hello world 12345/i);
    assert.match(chineseResults[1].value.join("\n"), /系统原生 OCR 测试/);
  } else console.log("SKIP: Simplified Chinese language pack is not installed.");
  const defaults = await run(["english.png"], "auto");
  assert.equal(defaults[0].status, "fulfilled");
  const missingLanguage = ["tr-TR", "ar-SA", "ja-JP", "ko-KR", "fr-FR"].find((language) => !engine.info.languages.includes(language));
  if (missingLanguage) {
    const missing = new NativeOcrEngine({ ...options, language: missingLanguage });
    try { await assert.rejects(missing.initialize(), /language is unavailable/); }
    finally { await missing.destroy(); }
    const process = new NativeProcess(await nativeCommand(options.pluginDir, version));
    try {
      const response = await process.request({ kind: "recognize", index: 0, path: path.join(fixtureDir, "english.png"), language: missingLanguage });
      assert.equal(response.ok, false);
      assert.match(response.error, /language unavailable/);
    } finally { await process.stop(); }
  } else console.log("SKIP: all candidate language packs are installed.");
  console.log("PASS: shipped Windows OCR bridge: English, available Chinese/mixed text, Unicode paths, system default, blank/corrupt/oversized images, missing language, progress, ordering, partial failure and cleanup.");
} finally { await engine?.destroy(); await rm(directory, { recursive: true, force: true }); }
