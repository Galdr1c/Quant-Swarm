import { describe, expect, it } from "vitest";
import { parseSubscriptions } from "../src/live-config.js";

describe("live market subscriptions", () => {
  it("parses TradingView exchange-qualified symbols using the final colon as timeframe separator", () => {
    expect(parseSubscriptions("NASDAQ:AAPL:15m,BINANCE:BTCUSDT:1h")).toEqual([
      { symbol: "NASDAQ:AAPL", timeframe: "15m" },
      { symbol: "BINANCE:BTCUSDT", timeframe: "1h" },
    ]);
  });

  it("keeps legacy direct-exchange symbols working", () => {
    expect(parseSubscriptions("BTCUSDT:15m")).toEqual([
      { symbol: "BTCUSDT", timeframe: "15m" },
    ]);
  });
});
