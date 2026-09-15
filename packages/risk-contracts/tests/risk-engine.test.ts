import { describe, it, expect } from "vitest";
import {
  RiskEngine,
  DEFAULT_RISK_LIMITS,
  InMemoryKillSwitchStore,
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
    price: 60_000,
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
    const result = engine.evaluateOrder(makeOrder(), makeState({ dailyPnlPct: -3.5 }));
    expect(result.approved).toBe(false);
    if (!result.approved) expect(result.reason).toBe("DAILY_LOSS_LIMIT");
  });

  it("rejects and activates kill switch on max drawdown", () => {
    const engine = new RiskEngine(DEFAULT_RISK_LIMITS, "shadow");
    const result = engine.evaluateOrder(makeOrder(), makeState({ drawdownPct: 16 }));
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

  it("supports a shared kill-switch store", () => {
    const store = new InMemoryKillSwitchStore();
    const first = new RiskEngine(DEFAULT_RISK_LIMITS, "shadow", false, store);
    const second = new RiskEngine(DEFAULT_RISK_LIMITS, "shadow", false, store);
    first.activateKillSwitch();
    expect(second.isKillSwitchActive()).toBe(true);
  });

  it("rejects excessive leverage", () => {
    const engine = new RiskEngine(DEFAULT_RISK_LIMITS, "shadow");
    const result = engine.evaluateOrder(makeOrder({ leverage: 10 }), makeState());
    expect(result.approved).toBe(false);
    if (!result.approved) expect(result.reason).toBe("MAX_LEVERAGE");
  });

  it("rejects when portfolio exposure exceeded", () => {
    const engine = new RiskEngine(DEFAULT_RISK_LIMITS, "shadow");
    const result = engine.evaluateOrder(makeOrder(), makeState({ totalExposurePct: 48 }));
    expect(result.approved).toBe(false);
    if (!result.approved) expect(result.reason).toBe("MAX_PORTFOLIO_EXPOSURE");
  });

  it("rejects when symbol exposure exceeded", () => {
    const engine = new RiskEngine(DEFAULT_RISK_LIMITS, "shadow");
    const state = makeState({ symbolExposures: new Map([["BTCUSDT", 8]]) });
    const result = engine.evaluateOrder(makeOrder(), state);
    expect(result.approved).toBe(false);
    if (!result.approved) expect(result.reason).toBe("MAX_SYMBOL_EXPOSURE");
  });

  it("reduce-only order decreases rather than increases exposure", () => {
    const engine = new RiskEngine(DEFAULT_RISK_LIMITS, "shadow");
    const state = makeState({
      totalExposurePct: 48,
      symbolExposures: new Map([["BTCUSDT", 8]]),
    });
    const result = engine.evaluateOrder(
      makeOrder({ side: "SELL", reduceOnly: true }),
      state
    );
    expect(result.approved).toBe(true);
    if (result.approved) {
      expect(result.projectedPortfolioExposurePct).toBeCloseTo(42);
      expect(result.projectedSymbolExposurePct).toBeCloseTo(2);
    }
  });

  it("does not infer reduce-only intent from SELL side", () => {
    const engine = new RiskEngine(DEFAULT_RISK_LIMITS, "shadow");
    const state = makeState({
      totalExposurePct: 48,
      symbolExposures: new Map([["BTCUSDT", 8]]),
    });
    const result = engine.evaluateOrder(makeOrder({ side: "SELL" }), state);
    expect(result.approved).toBe(false);
  });

  it("rejects live trading when disabled", () => {
    const engine = new RiskEngine(DEFAULT_RISK_LIMITS, "live", false);
    const result = engine.evaluateOrder(makeOrder(), makeState());
    expect(result.approved).toBe(false);
    if (!result.approved) expect(result.reason).toBe("LIVE_TRADING_DISABLED");
  });

  it("rejects malformed orders", () => {
    const engine = new RiskEngine(DEFAULT_RISK_LIMITS, "shadow");
    const result = engine.evaluateOrder(makeOrder({ quantity: 0 }), makeState());
    expect(result.approved).toBe(false);
    if (!result.approved) expect(result.reason).toBe("INVALID_ORDER");
  });

  it("limits are frozen and cannot be mutated", () => {
    const engine = new RiskEngine(DEFAULT_RISK_LIMITS, "shadow");
    const limits = engine.getLimits();
    expect(() => {
      (limits as any).maxLeverage = 999;
    }).toThrow();
  });
});
