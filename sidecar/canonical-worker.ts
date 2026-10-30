// No provider channel, application routes, credentials or persistence adapter.
import { Socket } from "node:net";
import { canonicalWorkerRuntime } from "./canonical-worker-runtime.ts";
process.umask(0o077);
const channel = new Socket({ fd: 3, readable: true, writable: true });
canonicalWorkerRuntime(channel, channel, code => { channel.destroy(); process.exit(code); });
