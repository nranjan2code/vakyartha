import type { AppManifest } from './app-manifest.ts';

export const APP_DOCUMENTS = ['README.md', 'AGENTS.md', 'SKILLS.md', 'ARCHITECTURE.md'] as const;

/** An honest executable starting point: its count is real local state, not a
 * fabricated external dataset or a claim that refresh/security was measured. */
export function createAppScaffold(name = 'custom-app'): { manifest: AppManifest; files: Record<string, string> } {
  const id = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 64).replace(/-$/g, '') || 'custom-app';
  const manifest: AppManifest = {
    id: id.length < 2 ? `${id}-app` : id, version: '1.0.0', name: id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    description: 'Starter app with a persistent local counter. Adapt its behavior and documentation before presenting a domain application.',
    author: 'Studio Author', icon: 'cpu', category: 'utilities', entrypoints: { backend: 'server.ts', surface: 'surface.json' },
    runtime: { engine: 'node24', memoryLimitMb: 256, cpuTimeLimitSec: 30, maxStorageMb: 16 },
    entitlements: { network: { mode: 'airgap', allowedDomains: [] }, mcpTools: [], storage: { sqlite: false, duckdb: false } }, triggers: [],
  };
  const files: Record<string, string> = {
    'server.ts': `export async function handleAction(controlId, value, context, action) {
  if (action !== 'increment' && controlId !== 'increment') throw new Error('Unknown action');
  context.state.count = Number(context.state.count ?? 0) + 1;
  return { updates: Object.keys(context.surfaces).map(surface => ({ surface, data: { count: context.state.count } })) };
}
`,
    'surface.json': JSON.stringify({ id: `${manifest.id}-main`, title: manifest.name, version: 1, data: { count: 0 }, nodes: [
      { id: 'root', type: 'stack', props: { gap: 'md' }, children: ['purpose', 'count', 'increment'] },
      { id: 'purpose', type: 'text', props: { content: 'Starter application: a saved local counter. No external data or scheduled refresh is configured.' } },
      { id: 'count', type: 'stat', props: { label: 'Saved increments', value: '{/count}', maxWidth: 'sm' } },
      { id: 'increment', type: 'button', props: { label: 'Increment counter', action: 'increment', style: 'primary' } },
    ] }, null, 2) + '\n',
    'README.md': `# ${manifest.name}

## Purpose and current implementation
This starter implements a persistent local counter only. It is a draft starting point for a domain application, not evidence that a requested domain workflow has been built.

## Setup and use
Review and rehearse this package in Studio, then publish explicitly. Open the app and press Increment counter. Each successful sandbox invocation increments the saved integer once. No integration, credential or network permission is required.

## Data, persistence and scheduling
The only canonical field is context.state.count, initially zero. Its matching surface projection commits with the app revision. Reopening reads the saved value. No database or schedule is declared. Module memory and scratch files do not persist.

## Failure, verification and limitations
A missing/disabled helper fails closed. Inspect the run receipt; do not substitute host execution. Before claiming verification, rehearse an increment, check exact 0 → 1 → 2 values, reopen and check 2, inspect wide/narrow WebKit controls and retain actual receipts. These steps have not been run for a newly created draft. No remote refresh, streaming or domain calculation is implemented.

## Maintenance
Read AGENTS.md, SKILLS.md and ARCHITECTURE.md. Change source and all affected docs together through a reviewed draft; preserve existing data unless a reset is explicitly requested.
`,
    'AGENTS.md': `# Working on ${manifest.name}

Read README.md, SKILLS.md and ARCHITECTURE.md plus applicable repository rules before editing.

- Canonical state: context.state.count is a nonnegative integer; surface data is its projection, not another writer.
- The only action is increment. Keep handler exports, action IDs and visible labels consistent.
- No external tools, secrets, packages, databases or schedules are declared. Adding a capability requires its actual supported runtime contract and normal permissions.
- Preserve source fingerprints, saved values and independent surfaces when changing the package. Create an inert draft, rehearse, verify and review before publication.
- Freeze known-value/action/reopen checks before evaluation. Retain failures and report the verified scope truthfully.
- Update README.md, this file, SKILLS.md and ARCHITECTURE.md whenever their documented behavior or boundaries change. Never call an incomplete domain draft finished.
`,
    'SKILLS.md': `# Procedural support for ${manifest.name}

- app-authoring: complete executable package and four-document template; use when constructing domain behavior.
- app-maintainer: reviewed updates, documentation alignment and state/schema preservation.
- app-debugger with debug-error: diagnose a failed handler, publication, persistence or projection from actual receipts.
- app-operator and app-admin: published actions, scheduling and runtime inspection.
- interactive-ui and required surface-design: bindings, actions, readable responsive layouts and spoken content.

No domain skill or external integration is needed for the current counter. Add only actual relevant enabled skills when adapting the app, and explain when each is used. This file is documentation, not a loader manifest. Skill selection grants no authority; ordinary published actions require no model request. Read supporting templates with read_skill_file after selecting their skill.
`,
    'ARCHITECTURE.md': `# ${manifest.name}: architecture

## File and data ownership
app.json declares identity, Node entrypoints and no tools/schedules/database. server.ts owns the increment calculation. surface.json owns the initial counter presentation. context.state.count is the sole canonical domain field, projected into every existing surface.

## Action flow
Button → revision-checked serialized app owner → disposable supervised sandbox → handleAction → validated Projection update → atomic state/surfaces/revision commit → visible view. Reopening reads committed state. A failed invocation publishes no candidate state.

## Boundaries and extension
The existing helper owns containment; the app host owns persistence and tool authority; Projection owns rendering/bindings. No raw network or permanent process exists. Check the current host runtime bounds before adapting this starter. Keep domain code here, general renderer defects in Projection, integration lifecycle in its owner and containment in the sandbox owner. State schema version 1 has only count; domain schema changes require an explicit compatibility/migration plan. Update all four documents with the implementation and verification evidence.
`,
  };
  return { manifest, files };
}
