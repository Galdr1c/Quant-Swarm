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
import {
  JsonlTradeLedger,
  JsonPaperDayStateStore,
  PaperExecutor,
  PaperPortfolio,
  brokerFill,
  rebuildPaperPortfolio,
} from "../src/index.js";

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

  it("maintains cash, positions, realized/unrealized PnL and risk state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quant-swarm-trades-"));
    const ledger = new JsonlTradeLedger(join(dir, "portfolio.jsonl"));
    const ids = ["buy-001", "sell-001"];
    const executor = new PaperExecutor(ledger, {
      slippageBps: 0,
      feeBps: 0,
      now: () => 1_800_000_000_000,
      idFactory: () => ids.shift()!,
    });
    const risk = new RiskEngine(DEFAULT_RISK_LIMITS, "paper");
    const portfolio = new PaperPortfolio(100_000);

    const buy = await executor.executeAgainstPortfolio(
      order(),
      portfolio,
      risk,
      { "NASDAQ:AAPL": 200 },
      100_000
    );
    expect(buy.risk.approved).toBe(true);
    expect(buy.portfolio?.cash).toBeCloseTo(98_000);
    expect(buy.portfolio?.positions[0]).toMatchObject({
      symbol: "NASDAQ:AAPL",
      quantity: 10,
      averageEntryPrice: 200,
    });

    const marked = portfolio.snapshot({ "NASDAQ:AAPL": 210 });
    expect(marked.equity).toBeCloseTo(100_100);
    expect(marked.unrealizedPnl).toBeCloseTo(100);

    const sell = await executor.executeAgainstPortfolio(
      { ...order(), side: "SELL", quantity: 5, price: 210, reduceOnly: true },
      portfolio,
      risk,
      { "NASDAQ:AAPL": 210 },
      100_000
    );
    expect(sell.risk.approved).toBe(true);
    expect(sell.portfolio?.cash).toBeCloseTo(99_050);
    expect(sell.portfolio?.realizedPnl).toBeCloseTo(50);
    expect(sell.portfolio?.positions[0].quantity).toBeCloseTo(5);
    expect(sell.portfolio?.unrealizedPnl).toBeCloseTo(50);

    const riskState = portfolio.toRiskState({ "NASDAQ:AAPL": 210 }, 100_000);
    expect(riskState.equity).toBeCloseTo(100_100);
    expect(riskState.dailyPnl).toBeCloseTo(100);
    expect(riskState.totalExposurePct).toBeGreaterThan(0);

    const rebuilt = await rebuildPaperPortfolio(ledger, 100_000);
    const rebuiltSnapshot = rebuilt.snapshot({ "NASDAQ:AAPL": 210 });
    expect(rebuiltSnapshot.cash).toBeCloseTo(sell.portfolio!.cash);
    expect(rebuiltSnapshot.realizedPnl).toBeCloseTo(50);
    expect(rebuiltSnapshot.positions[0].quantity).toBeCloseTo(5);
  });

  it("rejects unsettled paper sells before they enter the append-only ledger", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quant-swarm-trades-"));
    const ledger = new JsonlTradeLedger(join(dir, "portfolio.jsonl"));
    const executor = new PaperExecutor(ledger, {
      slippageBps: 0,
      feeBps: 0,
      idFactory: () => "bad-sell",
    });
    const risk = new RiskEngine(DEFAULT_RISK_LIMITS, "paper");
    const portfolio = new PaperPortfolio(100_000);

    await expect(
      executor.executeAgainstPortfolio(
        { ...order(), side: "SELL", quantity: 1, reduceOnly: true },
        portfolio,
        risk,
        { "NASDAQ:AAPL": 200 }
      )
    ).rejects.toThrow(/cannot sell more/);

    expect(await ledger.list()).toEqual([]);
  });

  it("persists one UTC daily loss baseline until the day changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quant-swarm-trades-"));
    const path = join(dir, "paper-day.json");
    const store = new JsonPaperDayStateStore(path);
    const day1 = Date.UTC(2026, 8, 30, 1, 0, 0);
    const day2 = Date.UTC(2026, 9, 1, 1, 0, 0);

    const first = await store.getOrCreate(100_000, day1);
    const higher = await store.getOrCreate(106_000, day1 + 4 * 60 * 60 * 1000);
    const sameDay = await store.getOrCreate(94_000, day1 + 8 * 60 * 60 * 1000);
    const nextDay = await store.getOrCreate(94_000, day2);

    expect(first.dayStartEquity).toBe(100_000);
    expect(higher.dayStartEquity).toBe(100_000);
    expect(higher.peakEquity).toBe(106_000);
    expect(sameDay.dayStartEquity).toBe(100_000);
    expect(sameDay.peakEquity).toBe(106_000);
    expect(sameDay.utcDate).toBe("2026-09-30");
    expect(nextDay.dayStartEquity).toBe(94_000);
    expect(nextDay.peakEquity).toBe(106_000);
    expect(nextDay.utcDate).toBe("2026-10-01");

    const persisted = JSON.parse(await readFile(path, "utf8"));
    expect(persisted).toMatchObject({
      schemaVersion: 1,
      utcDate: "2026-10-01",
      dayStartEquity: 94_000,
      peakEquity: 106_000,
    });
  });

  it("uses persisted historical peak for replayed drawdown risk", () => {
    const portfolio = new PaperPortfolio(100_000);
    const riskState = portfolio.toRiskState({}, 100_000, 120_000);

    expect(riskState.equity).toBe(100_000);
    expect(riskState.peakEquity).toBe(120_000);
    expect(riskState.drawdownPct).toBeCloseTo(16.6666667);
  });

  it("serializes ledger-backed paper executions so concurrent orders see fresh cash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quant-swarm-trades-"));
    const ledger = new JsonlTradeLedger(join(dir, "concurrent.jsonl"));
    const ids = ["concurrent-1", "concurrent-2"];
    const executor = new PaperExecutor(ledger, {
      slippageBps: 0,
      feeBps: 0,
      now: () => 1_800_000_000_000,
      idFactory: () => ids.shift()!,
    });
    const risk = new RiskEngine(
      {
        maxPortfolioExposurePct: 200,
        maxSymbolExposurePct: 200,
        maxDailyLossPct: 50,
        maxDrawdownPct: 90,
        maxLeverage: 3,
      },
      "paper"
    );
    const large = { ...order(), quantity: 300, price: 200 };

    const settled = await Promise.allSettled([
      executor.executeFromLedger(
        large,
        100_000,
        risk,
        { "NASDAQ:AAPL": 200 },
        100_000
      ),
      executor.executeFromLedger(
        large,
        100_000,
        risk,
        { "NASDAQ:AAPL": 200 },
        100_000
      ),
    ]);

    expect(settled.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((row) => row.status === "rejected")).toHaveLength(1);
    expect(await ledger.list("NASDAQ:AAPL")).toHaveLength(1);
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
