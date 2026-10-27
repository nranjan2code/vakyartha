// Built-in packages are authored as Agent Skills folders. The same directory is
// copied beside the bundled sidecar so source and installed builds load one set.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface BuiltinPackage { name: string; text: string; files: Map<string, Buffer> }

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "builtin-skills");
function supportingFiles(directory: string, prefix = ""): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Built-in skills cannot contain links: ${entry.name}`);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      for (const [name, bytes] of supportingFiles(path.join(directory, entry.name), relative)) files.set(name, bytes);
    } else if (entry.isFile() && relative !== "SKILL.md") files.set(relative, readFileSync(path.join(directory, entry.name)));
    else if (!entry.isFile()) throw new Error(`Unsupported built-in skill entry: ${relative}`);
  }
  return files;
}

const packageEntries = readdirSync(root, { withFileTypes: true });
if (packageEntries.some(entry => !entry.isDirectory())) throw new Error("Built-in skill root contains a non-package entry");
export const BUILTIN_PACKAGES: BuiltinPackage[] = packageEntries
  .map(entry => {
    const directory = path.join(root, entry.name);
    return { name: entry.name, text: readFileSync(path.join(directory, "SKILL.md"), "utf8"), files: supportingFiles(directory) };
  });
export const BUILTIN_SKILLS = BUILTIN_PACKAGES.map(pkg => pkg.text);
