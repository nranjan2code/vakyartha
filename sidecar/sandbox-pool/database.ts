// One bounded database snapshot commits with the app record, never a second writer.
import { constants, cpSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const MAX_DATABASE_BYTES = 2 * 1024 * 1024;
export function databaseSnapshot(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_DATABASE_BYTES/3)*4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid database snapshot');
  const bytes=Buffer.from(value,'base64');
  if (!bytes.length || bytes.length > MAX_DATABASE_BYTES || bytes.toString('base64') !== value) throw new Error('Invalid database snapshot');
  return value;
}
export function stageDuckDB(workspace: string): void {
  const here=path.dirname(fileURLToPath(import.meta.url));
  const packaged=path.join(here,'duckdb-runtime','node_modules');
  const resolve=createRequire(import.meta.url).resolve;
  const destination=path.join(workspace,'.vak-runtime','node_modules');
  mkdirSync(destination,{recursive:true,mode:0o700});
  // Stage only the reviewed platform runtime. No app paths or environment grant reads.
  for (const name of ['@duckdb/node-api','@duckdb/node-bindings',`@duckdb/node-bindings-${process.platform}-${process.arch}`]) {
    const source=existsSync(packaged)?path.join(packaged,name):path.dirname(resolve(`${name}/package.json`));
    cpSync(source,path.join(destination,name),{recursive:true,mode:constants.COPYFILE_FICLONE});
  }
}
