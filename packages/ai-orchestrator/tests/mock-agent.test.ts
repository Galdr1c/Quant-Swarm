import { describe, it, expect } from "vitest";
import { MockResearchAgent } from "../src/mock-agent.js";
import { validateStrategy } from "@quant-swarm/strategy-schema";
import type { CandidateEvent } from "@quant-swarm/shared";

describe("MockResearchAgent", () => {
  const agent = new MockResearchAgent();

  const makeEvent = (type: CandidateEvent["type"]): CandidateEvent => ({
    symbol: "BTCUSDT",
    type,
    score: 3.5,
    timestamp: Date.now(),
    metadata: { volumeZScore: 3.5 },
  });

  it("returns a valid strategy for VOLUME_ANOMALY", async () => {
    const result = await agent.investigate(makeEvent("VOLUME_ANOMALY"), {
      recentCandles: [],
    });

    expect(result.confidence).toBeGreaterThan(0);
    expect(result.reasoning).toContain("VOLUME_ANOMALY");

    const validation = validateStrategy(result.strategy);
    expect(validation.valid).toBe(true);
  });

  it("returns a valid strategy for PRICE_DISLOCATION", async () => {
    const result = await agent.investigate(makeEvent("PRICE_DISLOCATION"), {
      recentCandles: [],
    });

    const validation = validateStrategy(result.strategy);
    expect(validation.valid).toBe(true);
    expect(result.strategy.name).toContain("RSI");
  });

  it("returns a valid strategy for VOLATILITY_EXPANSION", async () => {
    const result = await agent.investigate(makeEvent("VOLATILITY_EXPANSION"), {
      recentCandles: [],
    });

    const validation = validateStrategy(result.strategy);
    expect(validation.valid).toBe(true);
    expect(result.strategy.name).toContain("Supertrend");
  });

  it("strategy IDs include the symbol", async () => {
    const result = await agent.investigate(makeEvent("VOLUME_ANOMALY"), {
      recentCandles: [],
    });
    expect(result.strategy.id).toContain("btcusdt");
  });
});
