import { describe, expect, it } from "vitest";
import {
  annualizationForTimeframe,
  buildUniverseReport,
  downsampleSeries,
  rankUniverseResults,
  summarizeUniverseResults,
  type UniverseResearchResult,
} from "../src/universe-report.js";

function completed(
  symbol: string,
  verdict: "PASS" | "REVIEW" | "FAIL",
  sharpe: number,
  netReturn: number
): UniverseResearchResult {
  return {
    symbol,
    timeframe: "1h",
    status: "COMPLETED",
    verdict,
    finalHoldout: {
      netReturn,
      annualReturn: netReturn,
      sharpe,
      sortino: sharpe,
      maxDrawdown: -8,
      profitFactor: 1.4,
      expectancy: 1,
      totalTrades: 10,
      winRate: 55,
    },
  };
}

describe("universe research report", () => {
  it("ranks verdict before Sharpe and holdout return", () => {
    const ranked = rankUniverseResults([
      completed("NASDAQ:B", "REVIEW", 9, 90),
      completed("NASDAQ:A", "PASS", 1.2, 10),
      completed("NASDAQ:C", "PASS", 1.8, 8),
      { symbol: "NASDAQ:D", timeframe: "1h", status: "NO_SIGNAL" },
    ]);

    expect(ranked.map((row) => row.symbol)).toEqual([
      "NASDAQ:C",
      "NASDAQ:A",
      "NASDAQ:B",
      "NASDAQ:D",
    ]);
  });

  it("summarizes final holdout results without calling it a profit probability", () => {
    const summary = summarizeUniverseResults([
      completed("A", "PASS", 1.2, 10),
      completed("B", "REVIEW", 0.8, -2),
      { symbol: "C", timeframe: "1h", status: "NO_SIGNAL" },
      { symbol: "D", timeframe: "1h", status: "ERROR", error: "x" },
    ]);

    expect(summary.assets).toBe(4);
    expect(summary.completed).toBe(2);
    expect(summary.pass).toBe(1);
    expect(summary.positiveHoldoutRate).toBe(50);
    expect(summary.averageHoldoutReturn).toBe(4);
    expect(summary.noSignal).toBe(1);
    expect(summary.errors).toBe(1);
  });

  it("builds a deterministic report envelope", () => {
    const report = buildUniverseReport(
      [completed("NASDAQ:A", "PASS", 1.2, 10)],
      "2026-09-22T00:00:00.000Z"
    );
    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: "2026-09-22T00:00:00.000Z",
      source: "tradingview",
      summary: { assets: 1, pass: 1 },
    });
  });

  it("downsamples while preserving first and last points", () => {
    const values = Array.from({ length: 101 }, (_, i) => i);
    const sampled = downsampleSeries(values, 10);
    expect(sampled).toHaveLength(10);
    expect(sampled[0]).toBe(0);
    expect(sampled.at(-1)).toBe(100);
  });

  it("maps common timeframes to continuous-calendar annualization", () => {
    expect(annualizationForTimeframe("1h")).toBeCloseTo(8766);
    expect(annualizationForTimeframe("4h")).toBeCloseTo(2191.5);
    expect(annualizationForTimeframe("1d")).toBeCloseTo(365.25);
  });
});
