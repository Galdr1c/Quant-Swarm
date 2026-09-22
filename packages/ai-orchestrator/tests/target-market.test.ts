import { describe, expect, it } from "vitest";
import { MockResearchAgent } from "../src/mock-agent.js";

describe("research target market", () => {
  it("keeps mock hypotheses on the requested symbol and timeframe", async () => {
    const agent = new MockResearchAgent();
    const hypothesis = await agent.investigate(
      {
        symbol: "NASDAQ:NVDA",
        type: "VOLUME_ANOMALY",
        score: 4,
        timestamp: 123,
        metadata: {},
      },
      {
        recentCandles: [],
        targetMarket: { symbol: "NASDAQ:NVDA", timeframe: "1h" },
      }
    );

    expect(hypothesis.strategy.market).toEqual({
      symbol: "NASDAQ:NVDA",
      timeframe: "1h",
    });
  });
});
