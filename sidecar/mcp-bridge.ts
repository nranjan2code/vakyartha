// Runs inside `vaksb worker`: connects the helper's private descriptor 3 to one
// stdio MCP server's stdin and stdout, so Rust hosts the server with no socket.
// The server inherits this process's containment and declared environment.
import { spawn } from "node:child_process";
import { Socket } from "node:net";

const [script, ...args] = process.argv.slice(2);
if (!script) process.exit(2);
const channel = new Socket({ fd: 3, readable: true, writable: true });
const server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", script, ...args], { cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "inherit"] });
channel.pipe(server.stdin);
server.stdout.pipe(channel);
server.on("exit", (code) => process.exit(code ?? 1));
server.on("error", () => process.exit(1));
channel.on("end", () => server.kill());
channel.on("error", () => server.kill());
