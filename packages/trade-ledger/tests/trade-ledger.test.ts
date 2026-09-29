import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RISK_LIMITS,
  RiskEngine,
  type PortfolioState,
  type ProposedOrder,
} from "@quant-swarm/risk-contracts";
import { JsonlTradeLedger, PaperExecutor, brokerFill } from "../src/index.js";

function state(): PortfolioState {
  return {
    equity: 100_000,
    peakEquity: 100_000,
    dailyPnl: 0,
    dailyPnlPct: 0,
    drawdownPct: 0,
    totalExposurePct: 0,
    symbolExposures: new Map(),
  };
}

function order(): ProposedOrder {
  return {
    symbol: "NASDAQ:AAPL",
    side: "BUY",
    quantity: 10,
    price: 200,
    leverage: 1,
    strategyId: "paper-aapl",
  };
}

describe("trade ledger and paper executor", () => {
  it("risk-checks, simulates adverse slippage and persists paper fills", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quant-swarm-trades-"));
    const path = join(dir, "trades.jsonl");
    const ledger = new JsonlTradeLedger(path);
    const executor = new PaperExecutor(ledger, {
      slippageBps: 10,
      feeBps: 5,
      now: () => 1_800_000_000_000,
      idFactory: () => "fill-001",
    });
    const risk = new RiskEngine(DEFAULT_RISK_LIMITS, "paper");

    const result = await executor.execute(order(), state(), risk);

    expect(result.risk.approved).toBe(true);
    expect(result.fill).toMatchObject({
      id: "fill-001",
      symbol: "NASDAQ:AAPL",
      mode: "paper",
      side: "BUY",
      timestamp: 1_800_000_000_000,
      strategyId: "paper-aapl",
      source: "paper-executor",
    });
    expect(result.fill!.price).toBeCloseTo(200.2);
    expect(result.fill!.fee).toBeGreaterThan(0);

    const rows = await ledger.list("NASDAQ:AAPL");
    expect(rows).toHaveLength(1);
    expect((await readFile(path, "utf8")).trim()).toContain('"mode":"paper"');
  });

  it("does not persist a fill when sovereign risk rejects the order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quant-swarm-trades-"));
    const ledger = new JsonlTradeLedger(join(dir, "trades.jsonl"));
    const executor = new PaperExecutor(ledger, { idFactory: () => "never-used" });
    const risk = new RiskEngine(DEFAULT_RISK_LIMITS, "paper");

    const result = await executor.execute(order(), { ...state(), dailyPnlPct: -4 }, risk);

    expect(result.risk).toEqual({ approved: false, reason: "DAILY_LOSS_LIMIT" });
    expect(result.fill).toBeUndefined();
    expect(await ledger.list()).toEqual([]);
  });

  it("accepts broker-recorded live fills without providing live execution", async () => {
    const fill = brokerFill({
      id: "broker-123",
      symbol: "BINANCE:BTCUSDT",
      side: "SELL",
      timestamp: 1_800_000_000_001,
      price: 70_000,
      quantity: 0.01,
      notional: 700,
      fee: 0.7,
      strategyId: "btc-live",
      externalId: "exchange-order-123",
    });

    expect(fill.mode).toBe("live");
    expect(fill.source).toBe("broker");
  });
});
