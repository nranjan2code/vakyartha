// Where the engine sidecar listens. Inside Tauri the shell knows (it started
// the sidecar); in a plain browser, for UI work against `npm run sidecar`,
// pass ?backend=http://127.0.0.1:<port>#token=<token> (or enter it when asked).

import { invoke, isTauri } from "@tauri-apps/api/core";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

export interface Backend {
  url: string;
  token: string;
}

export const inTauri = isTauri();

export async function connect(): Promise<Backend> {
  if (inTauri) return await invoke<Backend>("backend");
  const url = new URLSearchParams(location.search).get("backend");
  if (!url) throw new Error("No engine: open this page from the vak app, or add ?backend=http://127.0.0.1:<port> for a sidecar you started.");
  const key = `vak:token:${url}`;
  // A #token=… fragment stays in the browser (never sent in a request).
  let token = new URLSearchParams(location.hash.slice(1)).get("token") ?? sessionStorage.getItem(key) ?? "";
  if (!token) {
    token = prompt("Engine token (from the sidecar's VAK_READY line)") ?? "";
    sessionStorage.setItem(key, token);
  }
  return { url, token };
}

/** Closing the window hides it (engine and channels keep running) when true. */
export async function setKeepRunning(keep: boolean): Promise<void> {
  if (inTauri) await invoke("set_keep_running", { keep });
}

/** Launch at login: read it, or set it and read it back. Undefined outside the app. */
export async function autostart(enable?: boolean): Promise<boolean | undefined> {
  return inTauri ? await invoke<boolean>("autostart", { enable }) : undefined;
}

/** Open a link in the system browser; the app window never navigates away. */
export async function openExternal(href: string): Promise<void> {
  if (inTauri) await openUrl(href);
  else window.open(href, "_blank", "noopener");
}

/** Show a file or folder in Finder (the app only). */
export async function revealPath(path: string): Promise<void> {
  if (inTauri) await revealItemInDir(path);
}
