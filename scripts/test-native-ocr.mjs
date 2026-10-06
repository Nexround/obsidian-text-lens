import assert from "node:assert/strict";
import { mkdtemp, writeFile, readdir, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { bytes, loadNativeModules } from "./native-test-utils.mjs";
import { testPlugin } from "./test-plugin.mjs";

await mkdir("build", { recursive: true });
const directory = await mkdtemp(path.resolve("build/native-test-"));
try {
  const { NativeOcrEngine, normalizeWindowsLines, parseNativeInfo } = await loadNativeModules(path.join(directory, "modules"));
  assert.deepEqual(normalizeWindowsLines(["中 文 识 别", "Hello world", "中文 OCR 测试", "中\t文", "𠀀 文"]),
    ["中文识别", "Hello world", "中文 OCR 测试", "中\t文", "𠀀文"]);
  assert.throws(() => parseNativeInfo({ kind: "info", version: "old", languages: [], defaultLanguage: null, autoDetection: true, maxImageDimension: null }, "1.3.8"), /version/);
  assert.throws(() => parseNativeInfo({ kind: "info" }, "1.3.8"), /capabilities/);
  const helper = path.join(directory, "fixture.cjs");
  await writeFile(helper, `
const { createInterface } = require("node:readline");
const { readFileSync } = require("node:fs");
const send = (x) => process.stdout.write(JSON.stringify(x) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.kind === "info") return send({kind: "info", version: process.argv[2] || "1.3.8", languages: ["en-US"], defaultLanguage: "en-US", autoDetection: false, maxImageDimension: 4096});
  const marker = readFileSync(request.path, "utf8");
  if (marker === "crash") return process.exit(2);
  if (marker === "hang") return;
  if (marker === "corrupt") return process.stdout.write("bad json\\n");
  if (marker === "wrong-index") return send({kind: "result", index: 42, ok: true, lines: [], resized: false});
  if (marker === "invalid-lines") return send({kind: "result", index: request.index, ok: true, lines: [42], resized: false});
  if (marker === "fail" || marker === "decode") return send({kind: "result", index: request.index, ok: false, error: "fixture failure", code: marker});
  send({kind: "result", index: request.index, ok: true, lines: marker === "blank" ? [] : [marker], resized: marker === "large"});
});
`);
  const temporary = path.join(directory, "batches");
  await mkdir(temporary);
  const options = { pluginDir: directory, version: "1.3.8", language: "auto", verbose: false,
    command: { executable: process.execPath, args: [helper] }, tempRoot: temporary };
  const make = (extra = {}) => new NativeOcrEngine({ ...options, ...extra });
  const assertClean = async () => assert.deepEqual(await readdir(temporary), [], "batch temporary files must be removed");
  if (process.platform !== "win32" && process.platform !== "darwin") {
    const unavailable = make({ command: undefined });
    try { await assert.rejects(unavailable.initialize(), /not supported/); }
    finally { await unavailable.destroy(); }
  }
  const engine = make();
  await Promise.all([engine.initialize(), engine.initialize()]);
  assert.equal(engine.ready, true);
  const progress = [];
  const results = await engine.batchRecognize(["first", "fail", "third", "blank", "large"].map(bytes), 20, (done, total) => progress.push([done, total]));
  assert.deepEqual(results.map((item) => item.index), [0, 1, 2, 3, 4]);
  assert.deepEqual(results.map((item) => item.status), ["fulfilled", "rejected", "fulfilled", "fulfilled", "fulfilled"]);
  assert.deepEqual(results[2].value, ["third"]);
  assert.deepEqual(results[3].value, []);
  assert.equal(results[4].resized, true);
  assert.deepEqual(progress, [[1, 5], [2, 5], [3, 5], [4, 5], [5, 5]]);
  await assertClean();
  await engine.destroy();
  for (const marker of ["crash", "hang", "corrupt", "wrong-index", "invalid-lines"]) {
    const item = make({ timeoutMs: 1000 });
    await item.initialize();
    const output = await item.batchRecognize(["completed", marker, "remaining"].map(bytes), 3);
    assert.deepEqual(output.map((x) => x.status), ["fulfilled", "rejected", "rejected"], marker);
    assert.deepEqual(output[0].value, ["completed"]);
    await item.destroy();
    await assertClean();
  }
  for (const extra of [{ language: "missing" }, { command: { executable: process.execPath, args: [helper, "wrong-version"] } },
    { command: { executable: path.join(directory, "missing.exe"), args: [] } }]) {
    const item = make(extra);
    await assert.rejects(item.initialize());
    assert.equal(item.ready, false);
    await item.destroy();
  }
  let conversions = 0;
  const fallback = make({ convertToPng: async () => { conversions++; return bytes("converted"); } });
  await fallback.initialize();
  const converted = await fallback.batchRecognize(["decode", "fail"].map(bytes), 3);
  assert.equal(conversions, 1, "renderer conversion only follows a native decode failure");
  assert.deepEqual(converted[0].value, ["converted"]);
  assert.equal(converted[1].status, "rejected");
  await fallback.destroy();
  await assertClean();
  const unsupported = make({ convertToPng: async () => { throw new Error("not decodable"); } });
  await unsupported.initialize();
  const failedDecode = await unsupported.batchRecognize(["decode", "after"].map(bytes), 3);
  assert.match(failedDecode[0].reason.message, /unsupported or damaged/);
  assert.equal(failedDecode[1].status, "fulfilled");
  await unsupported.destroy();
  await assertClean();
  // Conversion shares the image deadline; unload cancels it promptly.
  for (const cancel of [false, true]) {
    let conversionStarted;
    const started = new Promise((resolve) => { conversionStarted = resolve; });
    const item = make({ timeoutMs: 1000, convertToPng: () => { conversionStarted(); return new Promise(() => {}); } });
    await item.initialize();
    const pending = item.batchRecognize(["decode", "after"].map(bytes), 1);
    await started;
    await assert.rejects(item.batchRecognize([bytes("duplicate")], 1), /already running/);
    if (cancel) await item.destroy();
    const output = await pending;
    assert.deepEqual(output.map((x) => x.status), ["rejected", "rejected"]);
    await item.destroy();
    await assertClean();
  }
  console.log("PASS: native protocol, ordering, partial failures, deadlines, cancellation, normalization, decoder fallback and temporary cleanup.");
  await testPlugin(directory);
} finally { await rm(directory, { recursive: true, force: true }); }
