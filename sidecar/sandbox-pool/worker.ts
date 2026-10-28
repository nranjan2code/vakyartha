// One invocation in the existing supervised sandbox. No host credentials or stdin.
import { readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, constants, fstatSync, readSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import type { DuckDBConnection, DuckDBInstance, DuckDBValue } from "@duckdb/node-api";
import { setTimeout as delay } from "node:timers/promises";

const MAX_DATABASE_BYTES = 2 * 1024 * 1024;

async function main(): Promise<void> {
  const request = JSON.parse(readFileSync(".vak-request.json", "utf8"));
  let instance: DuckDBInstance | undefined;
  let connection: DuckDBConnection | undefined;
  let database: { run(sql: string, values?: DuckDBValue[]): Promise<void>; query(sql: string, values?: DuckDBValue[]): Promise<Record<string, unknown>[]> } | undefined;
  if (request.duckdb) {
    const { DuckDBInstance } = await import(pathToFileURL(path.resolve('.vak-runtime/node_modules/@duckdb/node-api/lib/index.js')).href) as typeof import('@duckdb/node-api');
    instance = await DuckDBInstance.create(path.resolve('.vak-database.duckdb'), { threads: '1', memory_limit: '128MB', enable_external_access: 'false', autoinstall_known_extensions: 'false', autoload_known_extensions: 'false' });
    connection = await instance.connect();
    database = {
      async run(sql, values) { await connection!.run(sql, values); },
      async query(sql, values) {
        const reader = await connection!.runAndReadUntil(sql, 10001, values);
        const rows = reader.getRowObjectsJson();
        if (!reader.done || rows.length > 10000 || Buffer.byteLength(JSON.stringify(rows)) > 256 * 1024) throw new Error('Database query result exceeds bounds');
        return rows;
      },
    };
  }
  const context = { state: request.state, surfaces: request.surfaces, surface: request.surface, callTool, database };
  let sequence = 0;
  let bridge = Promise.resolve();
  async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    // One mailbox exchange at a time; no repeated/replayed effects.
    const previous = bridge;
    let release!: () => void;
    bridge = new Promise<void>(r => { release = r; });
    await previous;
    try {
      const id = sequence++;
      if (id >= 16) throw new Error("App tool-call allowance exceeded");
      const body = JSON.stringify({ id, name, args });
      if (Buffer.byteLength(body) > 16384) throw new Error("Tool request too large");
      writeFileSync(".vak-tool.tmp", body); renameSync(".vak-tool.tmp", ".vak-tool.json");
      const reply = `.vak-reply-${id}.json`;
      while (!existsSync(reply)) await delay(20);
      const result = JSON.parse(readFileSync(reply, "utf8"));
      if (result.error) throw new Error(result.error);
      return result.value;
    } finally { release(); }
  }
  const mod = await import(pathToFileURL(path.resolve(request.backend)).href);
  const handler = request.trigger ? mod[request.action] : mod.handleAction;
  if (typeof handler !== "function") throw new Error(`Missing app handler: ${request.trigger ? request.action : "handleAction"}`);
  const result = request.trigger
    ? await handler(context)
    : await handler(request.controlId, request.value, context, request.action);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("App handler must return an object");
  connection?.closeSync(); instance?.closeSync();
  // Read without following links; a failed/oversized checkpoint never commits.
  let snapshot: string | undefined;
  if (request.duckdb) {
    const fd = openSync('.vak-database.duckdb', constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_DATABASE_BYTES) throw new Error('Database snapshot exceeds 2 MiB');
      const bytes = Buffer.alloc(MAX_DATABASE_BYTES + 1);
      let size = 0;
      while (size <= MAX_DATABASE_BYTES) {
        const count = readSync(fd, bytes, size, bytes.length - size, null);
        if (!count) break;
        size += count;
      }
      if (size > MAX_DATABASE_BYTES) throw new Error('Database snapshot exceeds 2 MiB');
      snapshot = bytes.subarray(0, size).toString('base64');
    } finally { closeSync(fd); }
  }
  const body = JSON.stringify({ result, state: context.state, database: snapshot });
  if (Buffer.byteLength(body) > 4 * 1024 * 1024) throw new Error("App result exceeds 4 MiB");
  writeFileSync(".vak-result.json", body);
}
try { await main(); } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
