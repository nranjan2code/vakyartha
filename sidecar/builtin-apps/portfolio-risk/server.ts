// Pure TypeScript calculation engine for Portfolio Risk.
// Operates inside the Seatbelt sandboxed worker slot.

export interface PortfolioAsset {
  symbol: string;
  weight: number;
  expectedReturn: number;
  volatility: number;
}

export function computePortfolioVaR(
  portfolioValue: number,
  confidenceLevel: number,
  volatility: number,
  timeHorizonDays = 1
): number {
  // Standard Normal Z-scores: 95% -> 1.645, 99% -> 2.326
  const z = confidenceLevel >= 0.99 ? 2.326 : 1.645;
  const timeFactor = Math.sqrt(timeHorizonDays);
  return portfolioValue * z * volatility * timeFactor;
}

export function rebalanceWeights(riskTolerance: number): number[] {
  // Linear risk weighting: 0 (Ultra-conservative) to 100 (Ultra-aggressive)
  const norm = Math.max(0, Math.min(100, riskTolerance)) / 100;
  const equities = Math.round(20 + 60 * norm); // 20% to 80%
  const bonds = Math.round(50 - 35 * norm);    // 50% to 15%
  const commodities = Math.round(15 - 5 * norm); // 15% to 10%
  const cash = 100 - (equities + bonds + commodities);
  return [equities, bonds, commodities, cash];
}

export function handleAction(controlId: string, value: unknown): Record<string, unknown> {
  const riskTolerance = typeof value === "number" ? value : 65;
  const weights = rebalanceWeights(riskTolerance);
  const portfolioVal = 124_500;
  // Blended annualized volatility based on equity weight
  const annualizedVol = 0.08 + (weights[0]! / 100) * 0.14;
  const dailyVol = annualizedVol / Math.sqrt(252);
  const var95 = computePortfolioVaR(portfolioVal, 0.95, dailyVol, 1);
  const expectedReturn = (4.0 + (weights[0]! / 100) * 12.0).toFixed(1);
  const sharpe = ((Number(expectedReturn) - 4.5) / (annualizedVol * 100)).toFixed(2);

  return {
    op: "batch_update",
    controlId,
    value,
    patches: [
      { id: "card-var-95", props: { value: `$${var95.toFixed(2)}` } },
      { id: "card-expected-return", props: { value: `${expectedReturn}%` } },
      { id: "card-sharpe", props: { value: sharpe } },
      {
        id: "chart-section",
        props: {
          series: [{ name: "Allocation %", values: weights }],
        },
      },
    ],
  };
}
