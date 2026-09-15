import { describe, expect, it } from "vitest";
import type { MarketIntelligenceProvider, MarketIntelligenceSnapshot } from "@quant-swarm/market-data";
import { MarketIntelligenceScanner, rollingVolatilityBps } from "../src/intelligence-scanner.js";

function snapshot(overrides: Partial<MarketIntelligenceSnapshot> = {}): MarketIntelligenceSnapshot {
  return {
    exchange: "binance",
    symbol: "BTCUSDT",
    timestamp: 1_000,
    bestBid: 100,
    bestAsk: 100.1,
    midPrice: 100.05,
    spreadBps: 9.995,
    bidDepthUsd: 1_000_000,
    askDepthUsd: 400_000,
    orderBookImbalance: (1_000_000 - 400_000) / 1_400_000,
    fundingRate: 0.0008,
    nextFundingTime: 10_000,
    openInterest: 100,
    openInterestUsd: 10_005,
    markPrice: 100.5,
    indexPrice: 100,
    basisBps: 50,
    liquidationLongUsd: 1_200_000,
    liquidationShortUsd: 100_000,
    sourceLatencyMs: 0,
    ...overrides,
  };
}

const provider: MarketIntelligenceProvider = {
  name: "binance",
  async getSnapshot() {
    return snapshot();
  },
};

describe("MarketIntelligenceScanner", () => {
  it("emits deterministic microstructure candidates", () => {
    const scanner = new MarketIntelligenceScanner(provider, {
      orderBookImbalanceThreshold: 0.35,
      fundingRateThreshold: 0.0005,
      basisBpsThreshold: 10,
      spreadBpsThreshold: 5,
      liquidationUsdThreshold: 1_000_000,
      candidateCooldownMs: 0,
      volatilityBpsThreshold: 10_000,
    });

    const events = scanner.scanSnapshot(snapshot());
    const types = new Set(events.map((event) => event.type));
    expect(types).toContain("ORDERBOOK_IMBALANCE");
    expect(types).toContain("FUNDING_EXTREME");
    expect(types).toContain("BASIS_DISLOCATION");
    expect(types).toContain("SPREAD_WIDENING");
    expect(types).toContain("LIQUIDATION_SPIKE");
  });

  it("detects open-interest expansion across rolling samples", () => {
    const scanner = new MarketIntelligenceScanner(provider, {
      openInterestChangePctThreshold: 2,
      openInterestLookbackSamples: 2,
      candidateCooldownMs: 0,
      orderBookImbalanceThreshold: 0.99,
      fundingRateThreshold: 1,
      basisBpsThreshold: 10_000,
      spreadBpsThreshold: 10_000,
      liquidationUsdThreshold: 1_000_000_000,
      volatilityBpsThreshold: 10_000,
    });

    scanner.scanSnapshot(snapshot({ timestamp: 1_000, openInterest: 100, openInterestUsd: 10_000 }));
    const events = scanner.scanSnapshot(snapshot({ timestamp: 2_000, openInterest: 103, openInterestUsd: 10_300 }));
    const event = events.find((row) => row.type === "OPEN_INTEREST_EXPANSION");
    expect(event?.metadata.open_interest_change_pct).toBeCloseTo(3);
  });

  it("suppresses duplicate candidate types inside the cooldown window", () => {
    const scanner = new MarketIntelligenceScanner(provider, {
      candidateCooldownMs: 60_000,
      volatilityBpsThreshold: 10_000,
    });
    const first = scanner.scanSnapshot(snapshot({ timestamp: 1_000 }));
    const second = scanner.scanSnapshot(snapshot({ timestamp: 2_000 }));
    expect(first.length).toBeGreaterThan(0);
    expect(second).toHaveLength(0);
  });

  it("computes rolling return volatility from mid prices", () => {
    const value = rollingVolatilityBps([
      snapshot({ timestamp: 1_000, midPrice: 100 }),
      snapshot({ timestamp: 2_000, midPrice: 101 }),
      snapshot({ timestamp: 3_000, midPrice: 99 }),
      snapshot({ timestamp: 4_000, midPrice: 102 }),
    ], 4);
    expect(value).not.toBeNull();
    expect(value!).toBeGreaterThan(0);
  });
});
