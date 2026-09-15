import { describe, it, expect } from "vitest";
import {
  RiskEngine,
  DEFAULT_RISK_LIMITS,
  type PortfolioState,
  type ProposedOrder,
} from "../src/index.js";

function makeState(overrides: Partial<PortfolioState> = {}): PortfolioState {
  return {
    equity: 100_000,
    peakEquity: 100_000,
    dailyPnl: 0,
    dailyPnlPct: 0,
    drawdownPct: 0,
    totalExposurePct: 0,
    symbolExposures: new Map(),
    ...overrides,
  };
}

function makeOrder(overrides: Partial<ProposedOrder> = {}): ProposedOrder {
  return {
    symbol: "BTCUSDT",
    side: "BUY",
    quantity: 0.1,
    price: 60000,
    leverage: 1,
    strategyId: "test-001",
    ...overrides,
  };
}

describe("RiskEngine", () => {
  it("approves valid order within limits", () => {
    const engine = new RiskEngine(DEFAULT_RISK_LIMITS, "shadow");
    const result = engine.evaluateOrder(makeOrder(), makeState());
    expect(result.approved).toBe(true);
  });

  it("rejects when daily loss limit exceeded", () => {
    const engine = new RiskEngine(DEFAULT_RISK_LIMITS, "shadow");
    const state = makeState({ dailyPnlPct: -3.5 });
    const result = engine.evaluateOrder(makeOrder(), state);
    expect(result.approved).toBe(false);
    if (!result.approved) expect(result.reason).toBe("DAILY_LOSS_LIMIT");
  });

  it("rejects and activates kill switch on max drawdown", () => {
    const engine = new RiskEngine(DEFAULT_RISK_LIMITS, "shadow");
    const state = makeState({ drawdownPct: 16 });
    const result = engine.evaluateOrder(makeOrder(), state);
    expect(result.approved).toBe(false);
    if (!result.approved) expect(result.reason).toBe("MAX_DRAWDOWN");
    expect(engine.isKillSwitchActive()).toBe(true);
  });

  it("kill switch blocks all subsequent orders", () => {
    const engine = new RiskEngine(DEFAULT_RISK_LIMITS, "shadow");
    engine.activateKillSwitch();

    const result = engine.evaluateOrder(makeOrder(), makeState());
    expect(result.approved).toBe(false);
    if (!result.approved) expect(result.reason).toBe("KILL_SWITCH_ACTIVE");
  });

  it("rejects excessive leverage", () => {
    const engine = new RiskEngine(DEFAULT_RISK_LIMITS, "shadow");
    const order = makeOrder({ leverage: 10 });
    const result = engine.evaluateOrder(order, makeState());
    expect(result.approved).toBe(false);
    if (!result.approved) expect(result.reason).toBe("MAX_LEVERAGE");
  });

  it("rejects when portfolio exposure exceeded", () => {
    const engine = new RiskEngine(DEFAULT_RISK_LIMITS, "shadow");
    const state = makeState({ totalExposurePct: 48 });
    // 0.1 * 60000 = 6000 → 6% of 100k equity, 48 + 6 = 54 > 50
    const result = engine.evaluateOrder(makeOrder(), state);
    expect(result.approved).toBe(false);
    if (!result.approved)
      expect(result.reason).toBe("MAX_PORTFOLIO_EXPOSURE");
  });

  it("rejects when symbol exposure exceeded", () => {
    const engine = new RiskEngine(DEFAULT_RISK_LIMITS, "shadow");
    const exposures = new Map([["BTCUSDT", 8]]);
    const state = makeState({ symbolExposures: exposures });
    // 8% existing + 6% new = 14% > 10%
    const result = engine.evaluateOrder(makeOrder(), state);
    expect(result.approved).toBe(false);
    if (!result.approved)
      expect(result.reason).toBe("MAX_SYMBOL_EXPOSURE");
  });

  it("rejects live trading when disabled", () => {
    const engine = new RiskEngine(DEFAULT_RISK_LIMITS, "live", false);
    const result = engine.evaluateOrder(makeOrder(), makeState());
    expect(result.approved).toBe(false);
    if (!result.approved)
      expect(result.reason).toBe("LIVE_TRADING_DISABLED");
  });

  it("limits are frozen and cannot be mutated", () => {
    const engine = new RiskEngine(DEFAULT_RISK_LIMITS, "shadow");
    const limits = engine.getLimits();
    expect(() => {
      (limits as any).maxLeverage = 999;
    }).toThrow();
  });
});
