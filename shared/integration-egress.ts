// Integration hosts the desktop worker may reach through native egress, the
// vault key Rust attaches for each, and the hosts and key variables of local
// servers that need the network. Rust compiles integration-egress.json in.
import catalog from "./integration-egress.json" with { type: "json" };

export interface EgressHost { host: string; credential?: { account: string; header: string; format: string } }
export interface NetworkServer { hosts: string[]; env: Record<string, string> }
export const EGRESS_HOSTS: readonly EgressHost[] = catalog.hosts;
export const NETWORK_SERVERS: Readonly<Record<string, NetworkServer>> = catalog.servers;

/** The framework's vault account name for an integration secret. */
export function integrationSecretName(id: string, key: string): string {
  return `INTEGRATION_${id.replace(/[^a-z0-9]/gi, "_").toUpperCase()}_${key.toUpperCase()}`;
}
