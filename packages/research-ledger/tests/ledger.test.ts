import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  JsonlResearchLedger,
  MemoryResearchLedger,
  buildResearchEvidence,
  createTrialRecord,
  type ResearchTrialRecord,
} from "../src/index.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function trial(overrides: Partial<ResearchTrialRecord> = {}): ResearchTrialRecord {
  return createTrialRecord({
    runId: "run-1",
    trialId: "trial-1",
    createdAt: 1_000,
    candidate: {
      symbol: "BTCUSDT",
      type: "VOLUME_ANOMALY",
      score: 4,
      timestamp: 900,
      metadata: { volume_z_score: 4 },
    },
    strategyId: "strategy-1",
    confidence: 0.7,
    provenance: {
      provider: "openai",
      model: "gpt-6-astra",
      promptVersion: "research-v1",
      responseId: "resp-1",
    },
    metrics: {
      sharpe: 1.2,
      pValue: 0.01,
      outOfSampleReturns: [0.01, -0.005, 0.008, 0.004],
      regimeReturns: {
        trending: [0.01, 0.02],
        ranging: [0.002, -0.001],
        volatile: [0.001, 0.002],
      },
    },
    ...overrides,
  });
}

describe("research ledgers", () => {
  it("keeps independent copies in memory", async () => {
    const ledger = new MemoryResearchLedger();
    const record = trial();
    await ledger.append(record);
    record.metrics.sharpe = 99;
    const [stored] = await ledger.list("run-1");
    expect(stored.metrics.sharpe).toBe(1.2);
  });

  it("persists append-only JSONL records and filters by run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quant-swarm-ledger-"));
    tempDirs.push(dir);
    const ledger = new JsonlResearchLedger(join(dir, "research", "trials.jsonl"));
    await ledger.append(trial());
    await ledger.append(trial({ runId: "run-2", trialId: "trial-2", strategyId: "strategy-2" }));

    const all = await ledger.list();
    const run1 = await ledger.list("run-1");
    expect(all).toHaveLength(2);
    expect(run1).toHaveLength(1);
    expect(run1[0].provenance.model).toBe("gpt-6-astra");
  });

  it("rejects non-finite OOS and regime return evidence", () => {
    expect(() => trial({
      metrics: { sharpe: 1, outOfSampleReturns: [0.01, Number.NaN] },
    })).toThrow(/outOfSampleReturns/);

    expect(() => trial({
      metrics: { sharpe: 1, regimeReturns: { volatile: [0.01, Number.POSITIVE_INFINITY] } },
    })).toThrow(/regimeReturns\.volatile/);
  });
});

describe("buildResearchEvidence", () => {
  it("derives DSR/FDR/CSCV/regime evidence without inventing missing values", () => {
    const records = [
      trial(),
      trial({
        trialId: "trial-2",
        strategyId: "strategy-2",
        provenance: { provider: "kimi", model: "kimi-k3", promptVersion: "research-v1" },
        metrics: {
          sharpe: 0.9,
          pValue: 0.03,
          outOfSampleReturns: [0.005, -0.002, 0.004, 0.001],
        },
      }),
    ];

    const evidence = buildResearchEvidence(records, "trial-1", {
      annualization: 35_040,
      cscvBlocks: 4,
      purgedCv: { nObservations: 1_500, nSplits: 5, purgeBars: 4, embargoBars: 4 },
    });

    expect(evidence.trialSharpes).toEqual([1.2, 0.9]);
    expect(evidence.candidatePValues).toEqual([0.01, 0.03]);
    expect(evidence.selectedTrialIndex).toBe(0);
    expect(evidence.cscvReturns).toEqual([
      [0.01, 0.005],
      [-0.005, -0.002],
      [0.008, 0.004],
      [0.004, 0.001],
    ]);
    expect(evidence.regimeReturns?.trending).toEqual([0.01, 0.02]);
    expect(evidence.regimeReturns?.volatile).toEqual([0.001, 0.002]);
    expect(evidence.purgedCv?.embargoBars).toBe(4);
  });

  it("omits incomplete p-values and mismatched OOS paths", () => {
    const records = [
      trial(),
      trial({
        trialId: "trial-2",
        strategyId: "strategy-2",
        metrics: { sharpe: 0.8, outOfSampleReturns: [0.01, 0.02] },
      }),
    ];
    const evidence = buildResearchEvidence(records, "trial-2");
    expect(evidence.candidatePValues).toBeUndefined();
    expect(evidence.cscvReturns).toBeUndefined();
  });

  it("rejects evidence mixed across search runs", () => {
    expect(() => buildResearchEvidence([
      trial(),
      trial({ runId: "run-2", trialId: "trial-2", strategyId: "strategy-2" }),
    ], "trial-1")).toThrow(/runIds/);
  });
});
