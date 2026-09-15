import { describe, it, expect } from "vitest";
import { SyntheticMarketDataProvider } from "../src/synthetic.js";

describe("SyntheticMarketDataProvider", () => {
  it("generates the requested number of candles", async () => {
    const provider = new SyntheticMarketDataProvider({ seed: 42 });
    const candles = await provider.getHistoricalOHLCV("BTCUSDT", "15m", 1000);
    expect(candles).toHaveLength(1000);
  });

  it("produces deterministic output with same seed", async () => {
    const p1 = new SyntheticMarketDataProvider({ seed: 42 });
    const p2 = new SyntheticMarketDataProvider({ seed: 42 });
    const c1 = await p1.getHistoricalOHLCV("BTCUSDT", "15m", 100);
    const c2 = await p2.getHistoricalOHLCV("BTCUSDT", "15m", 100);
    expect(c1).toEqual(c2);
  });

  it("produces different output with different seeds", async () => {
    const p1 = new SyntheticMarketDataProvider({ seed: 42 });
    const p2 = new SyntheticMarketDataProvider({ seed: 99 });
    const c1 = await p1.getHistoricalOHLCV("BTCUSDT", "15m", 100);
    const c2 = await p2.getHistoricalOHLCV("BTCUSDT", "15m", 100);
    expect(c1[50].close).not.toEqual(c2[50].close);
  });

  it("each candle has valid OHLCV structure", async () => {
    const provider = new SyntheticMarketDataProvider();
    const candles = await provider.getHistoricalOHLCV("BTCUSDT", "15m", 500);

    for (const c of candles) {
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
      expect(c.volume).toBeGreaterThan(0);
      expect(c.timestamp).toBeGreaterThan(0);
    }
  });

  it("anomaly injection produces larger moves and volume", async () => {
    const anomalyIdx = 500;
    const provider = new SyntheticMarketDataProvider({
      seed: 42,
      anomalyIndices: [anomalyIdx],
    });
    const candles = await provider.getHistoricalOHLCV("BTCUSDT", "15m", 1000);

    // Volume at anomaly point should be significantly higher than average
    const avgVolume =
      candles.reduce((s, c) => s + c.volume, 0) / candles.length;
    expect(candles[anomalyIdx].volume).toBeGreaterThan(avgVolume * 2);
  });

  it("timestamps are monotonically increasing", async () => {
    const provider = new SyntheticMarketDataProvider();
    const candles = await provider.getHistoricalOHLCV("BTCUSDT", "1h", 200);

    for (let i = 1; i < candles.length; i++) {
      expect(candles[i].timestamp).toBeGreaterThan(candles[i - 1].timestamp);
    }
  });
});
