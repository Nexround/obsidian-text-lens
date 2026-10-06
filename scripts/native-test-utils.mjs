import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";

export async function loadNativeModules(directory) {
  await mkdir(directory, { recursive: true });
  await build({ entryPoints: ["src/native-ocr.ts", "src/native-helper.ts", "src/native-process.ts"],
    outdir: directory, bundle: true, format: "cjs", platform: "node", external: ["obsidian"], loader: { ".ps1": "text" }, logLevel: "silent" });
  const require = createRequire(import.meta.url);
  return { ...require(path.join(directory, "native-ocr.js")), ...require(path.join(directory, "native-helper.js")), ...require(path.join(directory, "native-process.js")) };
}

export function bytes(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}
