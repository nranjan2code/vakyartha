// Deliberately separate from main.ts: no app routes or canonical store adapter.
import { Socket } from "node:net";
import { taskWorkerRuntime } from "./task-worker-runtime.ts";

process.umask(0o077);
if (!process.env.VAK_DATA_DIR) throw new Error("Native task scratch directory is required");
const channel = new Socket({ fd: 3, readable: true, writable: true });
taskWorkerRuntime(channel, channel, process.env.VAK_DATA_DIR, code => { channel.destroy(); process.exit(code); });
