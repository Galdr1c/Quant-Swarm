import { describe, it, expect } from "vitest";
import { validateStrategy } from "../src/index.js";

describe("Strategy Schema Validation", () => {
  const validStrategy = {
    id: "btc-ema-rsi-001",
    name: "BTC EMA RSI Momentum",
    market: { symbol: "BTCUSDT", timeframe: "15m" },
    indicators: [
      { id: "emaFast", type: "EMA", params: { length: 9 } },
      { id: "emaSlow", type: "EMA", params: { length: 21 } },
      { id: "rsi", type: "RSI", params: { length: 14 } },
    ],
    entry: {
      operator: "AND",
      rules: [
        { left: "emaFast", operator: "crosses_above", right: "emaSlow" },
        { left: "rsi", operator: "<", right: 65 },
      ],
    },
    exit: {
      operator: "OR",
      rules: [
        { left: "emaFast", operator: "crosses_below", right: "emaSlow" },
      ],
    },
    risk: {
      stopLossPct: 1.5,
      takeProfitPct: 3,
      maxPositionPct: 5,
    },
  };

  it("accepts a valid strategy", () => {
    const result = validateStrategy(validStrategy);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.strategy).toBeDefined();
  });

  it("rejects missing required fields", () => {
    const result = validateStrategy({ id: "test" });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects undefined indicator references in entry rules", () => {
    const bad = {
      ...validStrategy,
      entry: {
        operator: "AND",
        rules: [
          { left: "nonexistent", operator: ">", right: 50 },
        ],
      },
    };
    const result = validateStrategy(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes("nonexistent"))).toBe(true);
  });

  it("rejects stopLoss >= takeProfit", () => {
    const bad = {
      ...validStrategy,
      risk: { stopLossPct: 5, takeProfitPct: 3, maxPositionPct: 5 },
    };
    const result = validateStrategy(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes("stopLossPct"))).toBe(true);
  });

  it("rejects invalid indicator type", () => {
    const bad = {
      ...validStrategy,
      indicators: [
        { id: "x", type: "INVALID_TYPE", params: { length: 10 } },
      ],
    };
    const result = validateStrategy(bad);
    expect(result.valid).toBe(false);
  });

  it("rejects empty indicators array", () => {
    const bad = { ...validStrategy, indicators: [] };
    const result = validateStrategy(bad);
    expect(result.valid).toBe(false);
  });

  it("rejects duplicate indicator ids", () => {
    const bad = {
      ...validStrategy,
      indicators: [
        { id: "dup", type: "EMA", params: { length: 9 } },
        { id: "dup", type: "RSI", params: { length: 14 } },
      ],
      entry: { operator: "AND", rules: [{ left: "dup", operator: ">", right: 50 }] },
      exit: { operator: "OR", rules: [{ left: "dup", operator: "<", right: 50 }] },
    };
    const result = validateStrategy(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes("duplicated"))).toBe(true);
  });

  it("rejects invalid indicator lengths and MACD ordering", () => {
    const badLength = {
      ...validStrategy,
      indicators: [{ id: "rsi", type: "RSI", params: { length: 0 } }],
      entry: { operator: "AND", rules: [{ left: "rsi", operator: "<", right: 30 }] },
      exit: { operator: "OR", rules: [{ left: "rsi", operator: ">", right: 60 }] },
    };
    expect(validateStrategy(badLength).valid).toBe(false);

    const badMacd = {
      ...validStrategy,
      indicators: [{
        id: "macd",
        type: "MACD",
        params: { fastLength: 30, slowLength: 20, signalLength: 9 },
      }],
      entry: { operator: "AND", rules: [{ left: "macd", operator: ">", right: 0 }] },
      exit: { operator: "OR", rules: [{ left: "macd", operator: "<", right: 0 }] },
    };
    const result = validateStrategy(badMacd);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes("fastLength"))).toBe(true);
  });
});
