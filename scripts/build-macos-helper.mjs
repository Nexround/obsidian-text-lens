import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

if (process.platform !== "darwin") throw new Error("Build the Vision helper on a Mac (release CI builds both architectures).");
const arch = process.argv[2] ?? process.arch;
if (!["arm64", "x64"].includes(arch)) throw new Error(`Unsupported architecture: ${arch}`);
const { version } = JSON.parse(readFileSync("manifest.json", "utf8"));
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error("Invalid plugin version");
const directory = path.resolve("build/native");
mkdirSync(directory, { recursive: true });
const source = path.join(directory, `main-${arch}.swift`);
const name = `text-lens-vision-darwin-${arch}`;
const output = path.join(directory, name);
const target = arch === "arm64" ? "arm64-apple-macosx11.0" : "x86_64-apple-macosx10.15";
writeFileSync(source, readFileSync("native/macos/main.swift", "utf8").replace("__TEXT_LENS_VERSION__", version));
try {
  execFileSync("xcrun", ["swiftc", "-O", "-target", target, "-framework", "Vision", "-framework", "ImageIO", source, "-o", output], { stdio: "inherit" });
  execFileSync("codesign", ["--force", "--sign", "-", output], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--strict", output], { stdio: "inherit" });
  const digest = createHash("sha256").update(readFileSync(output)).digest("hex");
  writeFileSync(output + ".sha256", `${digest}  ${name}\n`);
  console.log(`Built ${name} (${version}, target ${target}); ad-hoc signed and checksummed.`);
} finally { rmSync(source, { force: true }); }
