import { constants, closeSync, fsyncSync, fstatSync, readSync, openSync, writeFileSync, renameSync, mkdirSync, lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export function appId(id: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(id)) throw new Error("Invalid app identifier");
  return id;
}
export function relativeFile(name: string): string {
  if (name.length > 200 || name.includes("\\") || name.includes("\0") || name.split("/").some(p => !p || p === "." || p === ".." || p.startsWith(".vak-"))) throw new Error("Unsafe package file path");
  return name;
}
export function packageFiles(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Package files must be an object");
  const out: Record<string, string> = Object.create(null);
  let bytes = 0;
  for (const [name, text] of Object.entries(raw)) {
    relativeFile(name);
    if (["app.json", "state.json"].includes(name) || name.startsWith("data/") || name.startsWith("logs/")) throw new Error("Reserved runtime file");
    if (typeof text !== "string" || text.includes("\0")) throw new Error("Package files must contain UTF-8 text");
    bytes += Buffer.byteLength(text);
    if (Buffer.byteLength(text) > 1024 * 1024 || bytes > 4 * 1024 * 1024) throw new Error("Package exceeds text limits");
    out[name] = text;
  }
  const names = Object.keys(out);
  if (names.length > 100) throw new Error("Package exceeds file limit");
  for (const name of names) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) if (Object.hasOwn(out, parts.slice(0, i).join("/"))) throw new Error("Package file/directory conflict");
  }
  return out;
}
export function readBounded(file: string, limit = 8 * 1024 * 1024): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > limit) throw new Error("Invalid or oversized runtime file");
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size <= limit) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > limit) throw new Error("Runtime file grew beyond its bound");
    return buffer.subarray(0, size).toString("utf8");
  } finally { closeSync(fd); }
}
export function atomicJson(file: string, value: unknown): void {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error("App record exceeds 8 MiB");
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  const directory = openSync(path.dirname(file), constants.O_RDONLY);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
export function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function legacyFiles(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (root: string, prefix = "") => {
    if (lstatSync(root).isSymbolicLink()) throw new Error("Symbolic links are unsupported");
    for (const item of readdirSync(root, { withFileTypes: true })) {
      if (["app.json", "state.json", "data", "logs"].includes(item.name) && !prefix) continue;
      const name = prefix + item.name;
      relativeFile(name);
      if (item.isDirectory()) visit(path.join(root, item.name), `${name}/`);
      else if (item.isFile()) files[name] = readBounded(path.join(root, item.name), 1024 * 1024);
      else throw new Error("Unsupported package object");
      if (Object.keys(files).length > 100) throw new Error("Too many package files");
    }
  };
  visit(dir); return packageFiles(files);
}
