import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StrategyDefinition } from "@quant-swarm/strategy-schema";
import {
  PostgresResearchLedger,
  createTrialRecord,
  type ResearchTrialRecord,
} from "../src/index.js";

const connectionString = process.env.TEST_DATABASE_URL;
const enabled = Boolean(connectionString);
const schema = `quant_swarm_test_${process.pid}`;

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

function trial(overrides: Partial<ResearchTrialRecord> = {}): ResearchTrialRecord {
  const strategyId = overrides.strategyId ?? "strategy-pg-1";
  return createTrialRecord({
    runId: "pg-run-1",
    trialId: "pg-trial-1",
    createdAt: 1_000,
    candidate: {
      symbol: "BTCUSDT",
      type: "PRICE_DISLOCATION",
      score: 3.5,
      timestamp: 900,
      metadata: { returnZScore: 3.5 },
    },
    strategyId,
    strategySnapshot: overrides.strategySnapshot ?? strategy(strategyId),
    confidence: 0.65,
    provenance: {
      provider: "test",
      model: "fixture",
      promptVersion: "test-v1",
    },
    metrics: {
      sharpe: 1.2,
      pValue: 0.02,
      outOfSampleReturns: [0.01, -0.002, 0.006, 0.003],
      regimeReturns: {
        trending: [0.01, 0.006],
        ranging: [-0.002, 0.003],
        volatile: [0.001, -0.001],
      },
    },
    ...overrides,
  });
}

const suite = enabled ? describe : describe.skip;

suite("PostgresResearchLedger", () => {
  let ledger: PostgresResearchLedger;
  let admin: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString });
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    ledger = new PostgresResearchLedger({ connectionString, schema });
  });

  afterAll(async () => {
    if (ledger) await ledger.close();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it("atomically claims one run across competing ledger instances", async () => {
    const second = new PostgresResearchLedger({ connectionString, schema });
    try {
      const [firstClaim, secondClaim] = await Promise.all([
        ledger.claimRun("pg-run-1", 1_000),
        second.claimRun("pg-run-1", 1_000),
      ]);
      expect([firstClaim, secondClaim].sort()).toEqual([false, true]);
    } finally {
      await second.close();
    }
  });

  it("makes identical trial retries idempotent and rejects conflicts", async () => {
    const record = trial();
    expect(await ledger.append(record)).toBe("inserted");
    expect(await ledger.append(record)).toBe("duplicate");

    await expect(ledger.append(trial({ metrics: { sharpe: 8 } }))).rejects.toThrow(/Conflicting/);

    const rows = await ledger.list("pg-run-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].strategySnapshot?.id).toBe("strategy-pg-1");
    expect(rows[0].strategyFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("persists terminal run state and prevents later writes", async () => {
    await ledger.finishRun("pg-run-1", {
      status: "COMPLETED",
      updatedAt: 2_000,
      selectedTrialId: "pg-trial-1",
    });

    const run = await ledger.getRun("pg-run-1");
    expect(run?.status).toBe("COMPLETED");
    expect(run?.selectedTrialId).toBe("pg-trial-1");

    await expect(ledger.append(trial({ trialId: "pg-trial-2" }))).rejects.toThrow(/not writable/);
  });
});
