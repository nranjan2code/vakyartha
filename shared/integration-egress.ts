// Integration hosts the desktop worker may reach through native egress, and the
// vault key Rust attaches for each. Rust compiles integration-egress.json in.
import hosts from "./integration-egress.json" with { type: "json" };

export interface EgressHost { host: string; credential?: { account: string; header: string; format: string } }
export const EGRESS_HOSTS: readonly EgressHost[] = hosts;

/** The framework's vault account name for an integration secret. */
export function integrationSecretName(id: string, key: string): string {
  return `INTEGRATION_${id.replace(/[^a-z0-9]/gi, "_").toUpperCase()}_${key.toUpperCase()}`;
}
