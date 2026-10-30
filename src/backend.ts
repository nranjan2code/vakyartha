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

/** Opens a narrow native snapshot capability for a chat selected by the trusted UI. */
export async function admitNativeChat(sessionId: string): Promise<void> {
  if (inTauri) await invoke("control_admit_host_session", { sessionId });
}

/** Release a fresh admission when the trusted UI's operation failed before session persistence. */
export async function releaseNativeChatAdmission(sessionId: string): Promise<void> {
  if (inTauri) await invoke("control_release_host_session_admission", { sessionId });
}

export interface NativeSessionMigrationPlan {
  session_count: number;
  bytes: number;
  source_digest: string;
  already_migrated: boolean;
}

export interface NativeSessionMigrationReceipt {
  imported: number;
  already_present: number;
  bytes: number;
  source_digest: string;
}

export async function planNativeSessionMigration(): Promise<NativeSessionMigrationPlan | undefined> {
  return inTauri ? await invoke<NativeSessionMigrationPlan>("control_plan_host_session_migration") : undefined;
}

export async function migrateNativeSessions(expectedDigest: string): Promise<NativeSessionMigrationReceipt> {
  if (!inTauri) throw new Error("Native session migration is available only in the desktop app");
  return await invoke<NativeSessionMigrationReceipt>("control_migrate_host_sessions", { expectedDigest });
}

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

export interface EgressCheckResult {
  allowed: boolean;
  scheme: string;
  host: string;
  port?: number;
  reason?: string;
  matchType?: "builtin" | "custom" | "loopback" | "suffix" | "denied";
}

export function normalizeEgressTarget(destination: string | URL): { target: string; parsed?: URL; error?: string } {
  let target = typeof destination === "string" ? destination.trim() : destination.toString();
  if (typeof destination === "string") {
    if (!/^https?:\/\//i.test(target)) {
      if (/^(localhost|127\.0\.0\.1|::1)(:\d+)?(\/.*)?$/i.test(target)) {
        target = `http://${target}`;
      } else {
        target = `https://${target}`;
      }
    }
  }
  try {
    const parsed = new URL(target);
    return { target, parsed };
  } catch (err) {
    return { target, error: (err as Error).message };
  }
}

export async function checkEgressDetailed(destination: string | URL, customHosts?: string[]): Promise<EgressCheckResult> {
  const norm = normalizeEgressTarget(destination);
  if (norm.error || !norm.parsed) {
    return {
      allowed: false,
      scheme: "",
      host: typeof destination === "string" ? destination : destination.hostname,
      reason: `Cannot parse "${destination}" as a valid URL or host`,
      matchType: "denied",
    };
  }

  const scheme = norm.parsed.protocol.replace(/:$/, "");
  const host = norm.parsed.hostname;
  const port = norm.parsed.port ? Number(norm.parsed.port) : undefined;

  if (!inTauri) {
    return { allowed: true, scheme, host, port, matchType: "custom" };
  }

  try {
    const allowed = await invoke<boolean>("check_egress_endpoint", { scheme, host, port, customHosts });
    let matchType: "builtin" | "custom" | "loopback" | "suffix" = "builtin";
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      matchType = "loopback";
    } else if (customHosts?.some((c) => {
      let clean = c.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0] ?? "";
      if (clean.includes(":")) clean = clean.split(":")[0] ?? clean;
      return clean === host.toLowerCase() || (clean.startsWith(".") && host.toLowerCase().endsWith(clean) && host.length > clean.length);
    })) {
      matchType = "custom";
    } else if (host.endsWith(".databricks.com") || host.endsWith(".azuredatabricks.net")) {
      matchType = "suffix";
    }
    return { allowed, scheme, host, port, matchType };
  } catch (err) {
    return {
      allowed: false,
      scheme,
      host,
      port,
      reason: String((err as Error).message ?? err),
      matchType: "denied",
    };
  }
}

/** Check whether a destination endpoint is permitted by the engine egress policy. */
export async function checkEgress(destination: string | URL, customHosts?: string[]): Promise<boolean> {
  const result = await checkEgressDetailed(destination, customHosts);
  if (!result.allowed) {
    throw new Error(result.reason ?? "Blocked by Engine Egress Policy");
  }
  return true;
}

/** Open native folder picker dialog and return selected path, or null if cancelled. */
export async function pickFolder(): Promise<string | null> {
  if (inTauri) {
    try {
      const res = await invoke<string | null>("pick_folder");
      return res ? res.replace(/\/+$/, "") : null;
    } catch (e) {
      console.warn("Native folder picker invocation failed:", e);
    }
  }
  try {
    const res = await (await fetch("/api/workspaces/pick-folder", { method: "POST" })).json() as { ok: boolean; folder: string | null };
    return res.folder ? res.folder.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}
