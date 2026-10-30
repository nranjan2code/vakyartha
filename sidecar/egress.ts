// Outbound network egress policy enforcement in the TypeScript worker.
// Mirrors the indestructible Rust engine's egress policy (src-tauri/src/policy.rs, ADR-052).
// Denies arbitrary exfiltration, unapproved destinations, and raw IP requests.

export const ALLOWED_PROVIDER_HOSTS = new Set([
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "api.elevenlabs.io",
  "api.telegram.org",
  "huggingface.co",
  "registry.npmjs.org",
  "mcp.kite.trade",
  "mcp.nseindia.in",
  "api.typesafe.ai",
]);

export const ALLOWED_WORKSPACE_HOST_SUFFIXES = [
  ".cloud.databricks.com",
  ".azuredatabricks.net",
  ".gcp.databricks.com",
];

export const ALLOWED_LOOPBACK_PORTS = new Set([
  11434, // Ollama
  1234,  // LM Studio
]);

export interface EgressEvaluation {
  allowed: boolean;
  reason?: string;
}

export function parseCustomEgressHosts(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((s) => {
      let clean = s.trim().toLowerCase();
      clean = clean.replace(/^https?:\/\//, "");
      clean = clean.split("/")[0] ?? clean;
      return clean;
    })
    .filter(Boolean);
}

export function evaluateEgressUrl(
  target: string | URL,
  isTest = process.env.NODE_ENV === "test",
  customHosts = parseCustomEgressHosts(process.env.VAK_EXTRA_EGRESS_HOSTS)
): EgressEvaluation {
  try {
    const url = typeof target === "string" ? new URL(target) : target;
    const host = url.hostname.toLowerCase();

    // Check custom user-configured allowed hosts
    for (const custom of customHosts) {
      if (!custom) continue;
      const clean = custom.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0] ?? "";
      if (!clean) continue;
      if (clean.includes(":")) {
        const [h, p] = clean.split(":");
        const portStr = url.port || (url.protocol === "https:" ? "443" : "80");
        if (h === host && portStr === p) {
          return { allowed: true };
        }
      } else if (clean === host || (clean.startsWith(".") && host.endsWith(clean) && host.length > clean.length)) {
        return { allowed: true };
      }
    }

    // Loopback handling for local models or tests
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      if (isTest) return { allowed: true };
      const port = url.port ? Number(url.port) : (url.protocol === "https:" ? 443 : 80);
      if (ALLOWED_LOOPBACK_PORTS.has(port)) {
        return { allowed: true };
      }
      return { allowed: false, reason: `Loopback port ${port} is not in the allowed local model list` };
    }

    // Public egress must be HTTPS
    if (url.protocol !== "https:") {
      return { allowed: false, reason: "Public outbound network egress must use HTTPS" };
    }

    // Allowlisted provider hosts
    if (ALLOWED_PROVIDER_HOSTS.has(host)) {
      return { allowed: true };
    }

    // Allowlisted vendor workspace cloud suffixes
    if (ALLOWED_WORKSPACE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length)) {
      return { allowed: true };
    }

    return { allowed: false, reason: `Destination host ${host} is not in the authorized provider catalog` };
  } catch (err) {
    return { allowed: false, reason: `Invalid destination URL: ${(err as Error).message}` };
  }
}

/**
 * Creates an egress-guarded fetch function that wraps native fetch.
 * Refuses calls to unapproved destinations with a descriptive error.
 */
export function createGuardedFetch(underlying: typeof fetch = fetch, isTest = process.env.NODE_ENV === "test"): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const evalResult = evaluateEgressUrl(url, isTest);
    if (!evalResult.allowed) {
      throw new Error(`[egress policy] Outbound call denied: ${evalResult.reason}`);
    }
    return underlying(input, init);
  };
}

