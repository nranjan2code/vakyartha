import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { DuckDBInstance } from "@duckdb/node-api";

const options = {
  threads: "1",
  memory_limit: "128MB",
  enable_external_access: "false",
  autoinstall_known_extensions: "false",
  autoload_known_extensions: "false",
};
const dir = mkdtempSync(path.join(tmpdir(), "vak-linux-duckdb-"));

try {
  const oldFormat = path.join(dir, "existing.duckdb");
  writeFileSync(oldFormat, gunzipSync(readFileSync(process.argv[2])), { mode: 0o600 });
  const existing = await DuckDBInstance.create(oldFormat, options);
  const existingConnection = await existing.connect();
  const oldRows = await existingConnection.runAndReadAll("SELECT label, amount FROM migration_probe");
  assert.deepEqual(oldRows.getRowObjectsJson(), [{ label: "synthetic-fixture", amount: 17 }]);
  await existingConnection.run("INSERT INTO migration_probe VALUES (?, ?)", ["forward-write", 25]);
  existingConnection.closeSync();
  existing.closeSync();

  const reopened = await DuckDBInstance.create(oldFormat, options);
  const reopenedConnection = await reopened.connect();
  const forwardRows = await reopenedConnection.runAndReadAll("SELECT amount FROM migration_probe ORDER BY amount");
  assert.deepEqual(forwardRows.getRowObjectsJson(), [{ amount: 17 }, { amount: 25 }]);
  reopenedConnection.closeSync();
  reopened.closeSync();

  const currentFormat = path.join(dir, "new.duckdb");
  const current = await DuckDBInstance.create(currentFormat, options);
  const currentConnection = await current.connect();
  const currentRows = await currentConnection.runAndReadAll("SELECT version() AS version, 1 + 1 AS value");
  assert.deepEqual(currentRows.getRowObjectsJson(), [{ version: "v2.0.0", value: 2 }]);
  currentConnection.closeSync();
  current.closeSync();

  console.log(JSON.stringify({ node: process.version, duckdb: "2.0.0-r.1", platform: `${process.platform}-${process.arch}`, forwardRead: true, forwardWrite: true, currentFormat: true }));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
