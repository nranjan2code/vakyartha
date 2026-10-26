import { createHash } from "node:crypto";
import type { SessionView } from "@vak/host";
import type { TaskView } from "../shared/task-contract.ts";
import { checkComparisonContract, parseComparisonContract } from "../shared/comparison-contract.ts";
import { boundFieldValues, resultText, separateFormAndTable, tablePayloads } from "./evaluation-checks.ts";

// Expected calculations stay in the evaluator, not in the task's instructions.
const items = [{ item: "Desk kits", quantity: 3, unit_cost: 12 }, { item: "Lamp kits", quantity: 2, unit_cost: 17 }];
export const WORKSPACE_INPUTS = [
  { name: "inventory.csv", content: "item,quantity,unit_cost\n" + items.map((row) => `${row.item},${row.quantity},${row.unit_cost}`).join("\n") + "\n" },
  { name: "notes.md", content: "# Fictional workspace inventory\nSnapshot date: 2026-10-01. Budget: 100.\nDelivery dates are missing. Current file freshness is unverified; these are captured snapshots, not live inventory.\n" },
];
export const workspaceRows = () => [...items.map((row) => ({ ...row, line_total: row.quantity * row.unit_cost })), { item: "Grand total", quantity: "Not applicable", unit_cost: "Not applicable", line_total: items.reduce((sum, row) => sum + row.quantity * row.unit_cost, 0) }];
export function workspaceChecks(task: Pick<TaskView, "inputs"> & { runHistory: Pick<TaskView["runHistory"][number], "output">[] }, view: SessionView): Record<string, boolean> {
  const tables = tablePayloads(view), text = resultText(view);
  const contract = parseComparisonContract({ identityColumn: "item", rows: workspaceRows() });
  const receipt = task.runHistory.at(-1)?.output;
  return {
    inputSnapshotsMatch: task.inputs?.length === WORKSPACE_INPUTS.length && WORKSPACE_INPUTS.every((input) => task.inputs?.some((snapshot) => snapshot.name === input.name && snapshot.content === input.content && snapshot.bytes === Buffer.byteLength(input.content) && snapshot.sha256 === createHash("sha256").update(input.content).digest("hex"))) || false,
    independentSurfaces: separateFormAndTable(view),
    exactVisibleValues: tables.length === 1 && checkComparisonContract(contract, tables[0]!).length === 0,
    unsupportedDefaultsAbsent: boundFieldValues(view).every((field) => /budget/i.test(field.label) || field.value === undefined || field.value === null || field.value === "" || field.value === false),
    budgetInitialized: boundFieldValues(view).some((field) => /budget/i.test(field.label) && field.value === 100),
    sourcesNamed: WORKSPACE_INPUTS.every((input) => text.includes(input.name)),
    sampleLabel: /fictional/i.test(text),
    snapshotDate: text.includes("2026-10-01"),
    missingDelivery: /delivery.{0,60}(missing|unknown|not provided)|(missing|unknown).{0,60}delivery/i.test(text),
    freshnessUnverified: /freshness.{0,60}(unverified|unknown|not verified)|(unverified|unknown).{0,60}freshness/i.test(text),
    outputReferencesCurrentSurfaces: Boolean(receipt?.surfaces?.length && receipt.surfaces.length === view.surfaces.length && receipt.surfaces.every((ref) => view.surfaces.some((surface) => surface.id === ref.id && surface.version === ref.version))),
  };
}
