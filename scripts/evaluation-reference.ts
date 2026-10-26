import type { SessionView } from "@vak/host";
import { tableRows } from "./evaluation-checks.ts";

export type ComparisonFixture = {
  options: readonly { name: string; monthlyCost: number; seats: number }[];
  budget: number;
  minimumSeats: number;
};
export const COMPARISON_FIXTURE: ComparisonFixture = {
  options: [{ name: "Atlas", monthlyCost: 12, seats: 4 }, { name: "Birch", monthlyCost: 18, seats: 8 }],
  budget: 20, minimumSeats: 6,
};

/** A reference from supplied facts, independent of model prose or unused output data. */
export function comparisonReference(fixture: ComparisonFixture) {
  if (!Number.isFinite(fixture.budget) || fixture.budget < 0 || !Number.isInteger(fixture.minimumSeats) || fixture.minimumSeats < 1 || !fixture.options.length || new Set(fixture.options.map((option) => option.name)).size !== fixture.options.length) throw new Error("Invalid comparison fixture");
  return fixture.options.map((option) => {
    if (!option.name.trim() || !Number.isFinite(option.monthlyCost) || option.monthlyCost < 0 || !Number.isInteger(option.seats) || option.seats < 1) throw new Error("Invalid comparison option");
    const withinBudget = option.monthlyCost <= fixture.budget, enoughSeats = option.seats >= fixture.minimumSeats;
    return { ...option, costPerSeat: option.monthlyCost / option.seats, withinBudget, enoughSeats, meetsBoth: withinBudget && enoughSeats };
  });
}

export function comparisonReview(view: SessionView, fixture: ComparisonFixture) {
  const rows = tableRows(view);
  return {
    criteria: { budget: fixture.budget, minimumSeats: fixture.minimumSeats },
    options: comparisonReference(fixture).map((expected) => ({ expected, displayedRows: rows.filter((row) => row.includes(expected.name)) })),
    reasoning: "Manual review required: compare every displayed recommendation with its row's reference. Prose is not automatically verified.",
  };
}

/** Passing structural/numeric checks never establishes the meaning of generated prose. */
export function evaluationVerdict(checks: Record<string, boolean>): "failed" | "needs-semantic-review" {
  return Object.values(checks).length > 0 && Object.values(checks).every(Boolean) ? "needs-semantic-review" : "failed";
}
