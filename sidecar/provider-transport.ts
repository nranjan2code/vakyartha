import type { ProviderEntry, ProviderTransport } from "@vak/providers";

/** Route every app-owned model provider through the host's supplied transport. */
export function withProviderTransport(entries: ProviderEntry[], transport?: ProviderTransport): ProviderEntry[] {
  if (!transport) return entries;
  return entries.map((entry) => ({
    ...entry,
    make: (options: Parameters<ProviderEntry["make"]>[0]) => entry.make({ ...options, transport }),
  }));
}
