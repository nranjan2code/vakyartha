// Set the app version everywhere it is declared, so a release cannot ship
// with the About page, the bundle and package.json disagreeing:
//   node scripts/version.ts 0.2.0
// package.json (npm), src-tauri/Cargo.toml (CARGO_PKG_VERSION, shown in About
// and passed to the sidecar) and src-tauri/tauri.conf.json (the bundle's
// CFBundleShortVersionString). Cargo.lock follows on the next cargo build.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) {
  console.error("usage: node scripts/version.ts <major.minor.patch[-pre]>");
  process.exit(2);
}

function edit(file: string, pattern: RegExp, replacement: string): void {
  const p = path.join(repo, file);
  const text = readFileSync(p, "utf8");
  if (!pattern.test(text)) throw new Error(`no version field found in ${file}`);
  writeFileSync(p, text.replace(pattern, replacement));
}

edit("package.json", /("version":\s*")[^"]+(")/, `$1${version}$2`);
edit("src-tauri/tauri.conf.json", /("version":\s*")[^"]+(")/, `$1${version}$2`);
edit("src-tauri/Cargo.toml", /^(version = ")[^"]+(")/m, `$1${version}$2`);
console.log(`version ${version}: package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json`);
