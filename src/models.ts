// The current provider + model, the providers the engine offers, and the
// composer's model picker (recent models plus what local servers have
// installed; a hosted catalogue can hold hundreds, so those live in Settings).

import { $, api, el, prefs } from "./core.ts";

export interface ProviderInfo { id: string; label: string; available: boolean; reason?: string; defaultModel?: string; local?: boolean; keyVar?: string }

export let providers: ProviderInfo[] = [];
export const modelsOf = new Map<string, string[]>();
/** Why a provider could not list models (Ollama not running, a bad key). */
export const modelErrors = new Map<string, string>();
const initialProvider = prefs.get("provider") ?? "";
const initialModel = initialProvider ? (prefs.get(`model:${initialProvider}`) ?? "") : "";
export const current = { provider: initialProvider, model: initialModel };

const RECENT_MAX = 8;
export function recent(): [string, string][] {
  try {
    return (JSON.parse(prefs.get("recent") ?? "[]") as [string, string][]).filter((r) => Array.isArray(r) && r.length === 2);
  } catch {
    return [];
  }
}

export const labelOf = (id: string) => providers.find((p) => p.id === id)?.label ?? id;

/** Make a model current; the UI hears "vak:model" to refresh what depends on it. */
export function choose(provider: string, model: string): void {
  current.provider = provider;
  current.model = model;
  prefs.set("provider", provider);
  if (model) {
    prefs.set(`model:${provider}`, model);
    const rest = recent().filter(([p, m]) => p !== provider || m !== model);
    prefs.set("recent", JSON.stringify([[provider, model], ...rest].slice(0, RECENT_MAX)));
  }
  fillPicker();
  window.dispatchEvent(new Event("vak:model"));
}

const inFlightModels = new Map<string, Promise<{ models: string[]; error?: string }>>();

/** Ask a provider for its models with its current key (fresh every call). */
export async function listModels(p: ProviderInfo): Promise<{ models: string[]; error?: string }> {
  const inFlight = inFlightModels.get(p.id);
  if (inFlight) return inFlight;
  const promise = (async () => {
    try {
      const res = await api<{ models: string[]; default?: string; error?: string }>(`/api/models?provider=${encodeURIComponent(p.id)}`);
      modelsOf.set(p.id, res.models);
      if (res.error) modelErrors.set(p.id, res.error);
      else modelErrors.delete(p.id);
      return res;
    } catch (err) {
      modelErrors.set(p.id, (err as Error).message);
      return { models: [], error: (err as Error).message };
    } finally {
      inFlightModels.delete(p.id);
    }
  })();
  inFlightModels.set(p.id, promise);
  return promise;
}

/** Local servers are listed up front; a hosted provider only when it is the current one. */
export async function loadProviders(): Promise<void> {
  providers = await api<ProviderInfo[]>("/api/providers");
  const available = providers.filter((p) => p.available);
  const provider = available.find((p) => p.id === current.provider) ?? available.find((p) => p.local) ?? available[0];
  modelsOf.clear();
  modelErrors.clear();
  await Promise.all(available.filter((p) => p.local || p === provider).map(listModels));
  if (!provider) return choose("", "");
  const listed = modelsOf.get(provider.id) ?? [];
  // A declared default only counts for a local server when it is installed.
  const def = provider.defaultModel && (!provider.local || listed.includes(provider.defaultModel)) ? provider.defaultModel : undefined;
  choose(provider.id, prefs.get(`model:${provider.id}`) ?? def ?? (provider.local ? listed[0] : undefined) ?? "");
}

const key = (provider: string, model: string) => JSON.stringify([provider, model]);
export const option = (provider: string, model: string, text = model) => el("option", { value: key(provider, model), textContent: text });

/** Options for a model select: recent, then each reachable local server's installed models. */
export function modelOptions(): HTMLElement[] {
  const usable = new Set(providers.filter((p) => p.available).map((p) => p.id));
  const shown = new Set<string>();
  const out: HTMLElement[] = [];
  const rec = el("optgroup", { label: "Recent" });
  for (const [p, m] of recent()) {
    if (!usable.has(p)) continue;
    rec.append(option(p, m, `${m} · ${labelOf(p)}`));
    shown.add(key(p, m));
  }
  if (rec.children.length) out.push(rec);
  for (const p of providers.filter((x) => x.available && x.local)) {
    const group = el("optgroup", { label: p.label });
    for (const m of modelsOf.get(p.id) ?? []) if (!shown.has(key(p.id, m))) group.append(option(p.id, m));
    if (group.children.length) out.push(group);
  }
  return out;
}

export function fillPicker(): void {
  const pick = $<HTMLSelectElement>("model-pick");
  pick.replaceChildren(...modelOptions());
  const now = key(current.provider, current.model);
  if (current.model && ![...pick.options].some((o) => o.value === now)) pick.prepend(option(current.provider, current.model, `${current.model} · ${labelOf(current.provider)}`));
  if (!current.model) pick.prepend(el("option", { value: "", textContent: "Choose a model" }));
  pick.append(el("option", { value: "__settings", textContent: "More models…" }));
  pick.value = current.model ? now : "";
}

export function parseChoice(value: string): [string, string] | undefined {
  try {
    const v = JSON.parse(value) as unknown;
    return Array.isArray(v) && v.length === 2 ? (v as [string, string]) : undefined;
  } catch {
    return undefined;
  }
}
