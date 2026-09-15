import { describe, expect, it } from "vitest";
import { MemoryResearchLedger } from "@quant-swarm/research-ledger";
import type {
  ResearchAgent,
  ResearchContext,
  ResearchHypothesis,
} from "@quant-swarm/ai-orchestrator";
import type { CandidateEvent, OHLCV, ValidationReport } from "@quant-swarm/shared";
import type { StrategyDefinition } from "@quant-swarm/strategy-schema";
import {
  runResearchSearch,
  type BacktestWithEquity,
  type PsrEvidence,
  type ResearchQuantClient,
} from "../src/research-search.js";

const event: CandidateEvent = {
  symbol: "BTCUSDT",
  type: "PRICE_DISLOCATION",
  score: 3.8,
  timestamp: 1_700_000_000_000,
  metadata: { returnZScore: 3.8 },
};

function strategy(id: string): StrategyDefinition {
  return {
    id,
    name: id,
    market: { symbol: "BTCUSDT", timeframe: "15m" },
    indicators: [{ id: "rsi", type: "RSI", params: { length: 14 } }],
    entry: { operator: "AND", rules: [{ left: "rsi", operator: "<", right: 30 }] },
    exit: { operator: "OR", rules: [{ left: "rsi", operator: ">", right: 55 }] },
    risk: { stopLossPct: 2, takeProfitPct: 4, maxPositionPct: 3 },
  };
}

class FixedAgent implements ResearchAgent {
  constructor(readonly name: string, private readonly strategyId: string) {}

  async investigate(_event: CandidateEvent, _context: ResearchContext): Promise<ResearchHypothesis> {
    return {
      strategy: strategy(this.strategyId),
      confidence: 0.6,
      reasoning: `test ${this.strategyId}`,
      provenance: {
        provider: "test",
        model: this.name,
        promptVersion: "test-v1",
      },
    };
  }
}

function candles(start: number): OHLCV[] {
  return Array.from({ length: 40 }, (_, index) => ({
    timestamp: start + index * 60_000,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100.5 + index,
    volume: 10 + index,
  }));
}

class FakeQuantClient implements ResearchQuantClient {
  readonly validationSharpes: Record<string, number> = { s1: 0.8, s2: 1.5, s3: 1.1 };
  finalStrategyId?: string;
  evidenceSeen?: unknown;

  async backtest(input: StrategyDefinition, rows: OHLCV[]): Promise<BacktestWithEquity> {
    const isFinal = rows[0].timestamp >= 2_000_000;
    if (isFinal) this.finalStrategyId = input.id;
    const sharpe = isFinal ? 0.7 : this.validationSharpes[input.id];
    const drift = 0.001 + Math.max(sharpe, 0) * 0.0001;
    const equityCurve = [100_000];
    for (let i = 1; i < rows.length; i += 1) {
      const signed = i % 7 === 0 ? -drift * 0.35 : drift;
      equityCurve.push(equityCurve.at(-1)! * (1 + signed));
    }
    return {
      strategyId: input.id,
      netReturn: sharpe * 2,
      annualReturn: sharpe * 3,
      sharpe,
      sortino: sharpe + 0.2,
      maxDrawdown: 5,
      profitFactor: 1.4,
      expectancy: 0.1,
      totalTrades: 40,
      winRate: 52,
      avgWin: 0.3,
      avgLoss: -0.2,
      feesPaid: 10,
      slippagePaid: 5,
      equityCurve,
    };
  }

  async psr(equityCurve: number[], annualization: number): Promise<PsrEvidence> {
    const growth = equityCurve.at(-1)! / equityCurve[0] - 1;
    const pValue = Math.max(0.001, 0.05 - growth);
    return {
      probability: 1 - pValue,
      pValue,
      sharpe: 1,
      observations: equityCurve.length - 1,
      benchmarkSharpe: 0,
      annualization,
    };
  }

  async validateResearch(
    _result: BacktestWithEquity,
    evidence: any
  ): Promise<ValidationReport> {
    this.evidenceSeen = evidence;
    return {
      strategyId: this.finalStrategyId ?? "unknown",
      checks: [{ name: "test", verdict: "REVIEW" }],
      overallVerdict: "REVIEW",
    };
  }
}

describe("runResearchSearch", () => {
  it("selects on validation OOS, evaluates final holdout separately and builds ledger evidence", async () => {
    const ledger = new MemoryResearchLedger();
    const quant = new FakeQuantClient();
    const validation = candles(1_000_000);
    const holdout = candles(2_000_000);

    const result = await runResearchSearch({
      event,
      context: { recentCandles: candles(0).slice(-20) },
      agents: [
        new FixedAgent("agent-1", "s1"),
        new FixedAgent("agent-2", "s2"),
        new FixedAgent("agent-3", "s3"),
      ],
      validationCandles: validation,
      finalHoldoutCandles: holdout,
      ledger,
      quant,
      options: {
        runId: "run-test",
        annualization: 365.25 * 24 * 4,
        coordinator: { maxConcurrency: 2, timeoutMs: 1000 },
      },
    });

    expect(result.selectedStrategy.id).toBe("s2");
    expect(result.validationBacktest.sharpe).toBe(1.5);
    expect(quant.finalStrategyId).toBe("s2");
    expect(result.finalHoldoutBacktest.sharpe).toBe(0.7);

    const records = await ledger.list("run-test");
    expect(records).toHaveLength(3);
    expect(records.every((row) => (row.metrics.outOfSampleReturns?.length ?? 0) > 2)).toBe(true);
    expect(records.every((row) => row.metrics.pValue !== undefined)).toBe(true);

    expect(result.evidence.trialSharpes).toHaveLength(3);
    expect(result.evidence.candidatePValues).toHaveLength(3);
    expect(result.evidence.cscvReturns?.[0]).toHaveLength(3);
    expect(result.evidence.purgedCv?.nObservations).toBe(validation.length);
    expect(result.researchValidation.overallVerdict).toBe("REVIEW");
  });
});
