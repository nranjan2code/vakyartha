// Desktop connects to the Tauri parent's private engine IPC. Browser
// development uses the page origin, or an explicitly supplied HTTP backend.

import { desktopFetch } from "./desktop-fetch.ts";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

export interface Backend {
  url: string;
  token: string;
}

export const inTauri = isTauri();

/** Desktop traffic uses private IPC; browser development retains same-origin fetch. */
export const engineFetch: typeof fetch = (input, init) => inTauri ? desktopFetch(input, init) : fetch(input, init);

export async function connect(): Promise<Backend> {
  if (inTauri) return await invoke<Backend>("backend");
  const url = new URLSearchParams(location.search).get("backend");
  // Served by the app server itself (the playground): same origin, no token.
  if (!url) return { url: location.origin, token: "" };
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

/** Opens the Admin & Observability Console (native webview in Tauri or tab in browser). */
export async function openAdminConsole(): Promise<void> {
  if (inTauri) {
    try {
      await invoke("show_admin");
      return;
    } catch {}
  }
  window.open("/admin.html", "_blank", "noopener");
}

/** WebKit downloads need a native handler; keep export consistent in the app. */
export async function downloadMarkdown(filename: string, content: string): Promise<void> {
  if (inTauri) {
    await invoke("save_canvas", { filename, content });
    return;
  }
  const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Retrieve a secret from the trusted engine vault. */
export async function vaultGet(account: string, service?: string): Promise<string | null> {
  if (!inTauri) return null;
  return (await invoke<string | null>("vault_get", { account, service })) ?? null;
}

/** Store a secret into the trusted engine vault. */
export async function vaultSet(account: string, value: string, service?: string): Promise<void> {
  if (inTauri) {
    await invoke("vault_set", { account, value, service });
  }
}

/** Remove a secret from the trusted engine vault. */
export async function vaultDelete(account: string, service?: string): Promise<void> {
  if (inTauri) {
    await invoke("vault_delete", { account, service });
  }
}

/** Check whether a destination endpoint is permitted by the engine egress policy. */
export async function checkEgress(destination: string | URL, customHosts?: string[]): Promise<boolean> {
  if (!inTauri) return true;
  const parsed = typeof destination === "string" ? new URL(destination) : destination;
  const scheme = parsed.protocol.replace(/:$/, "");
  const host = parsed.hostname;
  const port = parsed.port ? Number(parsed.port) : undefined;
  return await invoke<boolean>("check_egress_endpoint", { scheme, host, port, customHosts });
}
