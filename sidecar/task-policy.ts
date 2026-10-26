import { PROVIDER_SETTINGS, type ProviderEntry } from "@vak/providers";
import type { TaskSpending } from "../shared/task-contract.ts";

/** App admission policy; a local service may still have its own costs or upstreams. */
export function checkTaskSpending(provider: ProviderEntry, spending: TaskSpending, env: Record<string, string | undefined>): void {
  if (spending.kind === "ceiling") throw new Error("Strict monetary ceilings cannot be enforced yet. No new work will start.");
  if (spending.kind === "api_allowed") return;
  const endpoints = PROVIDER_SETTINGS.filter((setting) => setting.provider === provider.id && !setting.secret && /^https?:\/\//.test(setting.placeholder ?? ""));
  if (!provider.local || endpoints.length !== 1) throw new Error("This task allows only a local provider. Choose one or explicitly allow model API charges in a new task.");
  const value = env[endpoints[0]!.name] || endpoints[0]!.placeholder!;
  let url: URL;
  try { url = new URL(value.includes("://") ? value : `http://${value}`); }
  catch { throw new Error("Check the local provider endpoint in Settings"); }
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) || url.username || url.password) throw new Error("Local-only tasks require a loopback provider endpoint. Review the endpoint in Settings.");
}
