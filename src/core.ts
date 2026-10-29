import { engineFetch } from "./backend.ts";
// Shared plumbing for the desktop UI: the engine connection, saved
// preferences, a confirm sheet and a small DOM builder.

import type { Backend } from "./backend.ts";

export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export const prefs = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(`vak:${k}`);
    } catch {
      return null;
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(`vak:${k}`, v);
    } catch {
      /* storage unavailable */
    }
  },
  remove(k: string): void {
    try {
      localStorage.removeItem(`vak:${k}`);
    } catch {
      /* storage unavailable */
    }
  },
};

let backend: Backend;
export function setBackend(b: Backend): void {
  backend = b;
}
export const engine = () => backend;

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await engineFetch(`${backend.url}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${backend.token}`, ...(init.headers as Record<string, string> | undefined) },
  });
  if (!res.ok && res.status !== 502) {
    const text = await res.text();
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      /* not JSON */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

/** A small yes/no sheet; window.confirm is not available in every webview. */
export function ask(text: string, ok = "Continue"): Promise<boolean> {
  const dialog = $<HTMLDialogElement>("ask");
  $<HTMLElement>("ask-text").textContent = text;
  $<HTMLButtonElement>("ask-ok").textContent = ok;
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "yes"), { once: true }));
}

type Child = Node | string | null | undefined | false;

/** el("div", { className: "x" }, child, "text"): text is always text, never HTML. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (k.startsWith("data-") || k.startsWith("aria-")) node.setAttribute(k, String(v));
    else (node as unknown as Record<string, unknown>)[k] = v;
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}
