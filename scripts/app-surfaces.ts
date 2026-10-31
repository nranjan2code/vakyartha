// Regenerates each built-in app's surface.json from its `surfaceFile()` export
// (the views of a new, empty app). test/reference-apps.test.ts fails when they drift.
import { readdirSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve("sidecar/builtin-apps");
for (const id of readdirSync(root)) {
  const server = path.join(root, id, "server.ts");
  if (!existsSync(server)) continue;
  const mod = await import(pathToFileURL(server).href) as { surfaceFile?: () => unknown };
  if (!mod.surfaceFile) continue;
  writeFileSync(path.join(root, id, "surface.json"), `${JSON.stringify(mod.surfaceFile(), null, 2)}\n`);
  console.log(`${id}/surface.json`);
}
