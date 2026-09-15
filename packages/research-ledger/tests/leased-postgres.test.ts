import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StrategyDefinition } from "@quant-swarm/strategy-schema";
import { createTrialRecord } from "../src/index.js";
import {
  LeasedPostgresResearchLedger,
  type ResearchRunLease,
} from "../src/leased-postgres.js";

const connectionString = process.env.TEST_DATABASE_URL;
const enabled = Boolean(connectionString);
const schema = `quant_swarm_lease_test_${process.pid}`;

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

function trial(runId: string, trialId: string, strategyId = "lease-strategy") {
  return createTrialRecord({
    runId,
    trialId,
    createdAt: 3_100,
    candidate: {
      symbol: "BTCUSDT",
      type: "PRICE_DISLOCATION",
      score: 4.2,
      timestamp: 3_000,
      metadata: { returnZScore: 4.2 },
    },
    strategyId,
    strategySnapshot: strategy(strategyId),
    confidence: 0.7,
    provenance: {
      provider: "test",
      model: "lease-fixture",
      promptVersion: "lease-v1",
    },
    metrics: {
      sharpe: 1.4,
      pValue: 0.01,
      outOfSampleReturns: [0.01, -0.002, 0.007, 0.003],
      regimeReturns: {
        trending: [0.01, 0.007],
        ranging: [-0.002, 0.003],
        volatile: [0.002, -0.001],
      },
    },
  });
}

const suite = enabled ? describe : describe.skip;

suite("LeasedPostgresResearchLedger", () => {
  let first: LeasedPostgresResearchLedger;
  let second: LeasedPostgresResearchLedger;
  let third: LeasedPostgresResearchLedger;
  let admin: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString });
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    first = new LeasedPostgresResearchLedger({ connectionString, schema });
    second = new LeasedPostgresResearchLedger({ connectionString, schema });
    third = new LeasedPostgresResearchLedger({ connectionString, schema });
  });

  afterAll(async () => {
    await Promise.all([first?.close(), second?.close(), third?.close()]);
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it("keeps an active lease exclusive and extends it with heartbeat", async () => {
    const lease = await first.claimRunLease("lease-active", {
      workerId: "worker-a",
      now: 1_000,
      leaseMs: 1_000,
    });
    expect(lease?.generation).toBe(1);

    const blocked = await second.claimRunLease("lease-active", {
      workerId: "worker-b",
      now: 1_500,
      leaseMs: 1_000,
    });
    expect(blocked).toBeUndefined();

    const renewed = await first.heartbeatRunLease(lease!, {
      now: 1_500,
      leaseMs: 1_000,
    });
    expect(renewed?.expiresAt).toBe(2_500);

    const stillBlocked = await second.claimRunLease("lease-active", {
      workerId: "worker-b",
      now: 2_499,
      leaseMs: 1_000,
    });
    expect(stillBlocked).toBeUndefined();
  });

  it("allows exactly one stale reclaim and fences the old worker", async () => {
    const oldLease = await first.claimRunLease("lease-reclaim", {
      workerId: "worker-old",
      now: 1_000,
      leaseMs: 1_000,
    });
    expect(oldLease?.generation).toBe(1);

    const [claimB, claimC] = await Promise.all([
      second.claimRunLease("lease-reclaim", {
        workerId: "worker-b",
        now: 2_000,
        leaseMs: 2_000,
      }),
      third.claimRunLease("lease-reclaim", {
        workerId: "worker-c",
        now: 2_000,
        leaseMs: 2_000,
      }),
    ]);
    const winners = [claimB, claimC].filter((lease): lease is ResearchRunLease => Boolean(lease));
    expect(winners).toHaveLength(1);
    const newLease = winners[0];
    expect(newLease.generation).toBe(2);

    expect(await first.heartbeatRunLease(oldLease!, {
      now: 2_100,
      leaseMs: 1_000,
    })).toBeUndefined();

    await expect(
      first.appendWithLease(
        trial("lease-reclaim", "lease-reclaim:g1:001:old"),
        oldLease!,
        2_100
      )
    ).rejects.toThrow(/lease lost or expired/);

    await expect(
      first.finishRunWithLease(oldLease!, {
        status: "FAILED",
        updatedAt: 2_100,
        error: "stale worker resumed",
      })
    ).rejects.toThrow(/lease lost or expired/);

    const winnerLedger = newLease.workerId === "worker-b" ? second : third;
    const record = trial("lease-reclaim", "lease-reclaim:g2:001:winner");
    expect(await winnerLedger.appendWithLease(record, newLease, 2_100)).toBe("inserted");
    expect(await winnerLedger.appendWithLease(record, newLease, 2_200)).toBe("duplicate");

    await winnerLedger.finishRunWithLease(newLease, {
      status: "COMPLETED",
      updatedAt: 2_300,
      selectedTrialId: record.trialId,
    });

    const run = await winnerLedger.getRun("lease-reclaim");
    expect(run?.status).toBe("COMPLETED");
    expect(run?.selectedTrialId).toBe(record.trialId);

    const terminalReclaim = await first.claimRunLease("lease-reclaim", {
      workerId: "worker-after-terminal",
      now: 10_000,
      leaseMs: 1_000,
    });
    expect(terminalReclaim).toBeUndefined();
  });

  it("rejects writes after a lease expires even before another worker reclaims", async () => {
    const lease = await first.claimRunLease("lease-expired", {
      workerId: "worker-expired",
      now: 5_000,
      leaseMs: 1_000,
    });
    expect(lease).toBeDefined();

    await expect(
      first.appendWithLease(
        trial("lease-expired", "lease-expired:g1:001:late"),
        lease!,
        6_000
      )
    ).rejects.toThrow(/lease lost or expired/);

    await expect(
      first.finishRunWithLease(lease!, {
        status: "FAILED",
        updatedAt: 6_000,
        error: "too late",
      })
    ).rejects.toThrow(/lease lost or expired/);
  });
});
