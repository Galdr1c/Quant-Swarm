import { describe, expect, it } from "vitest";
import { parseSubscriptions } from "../src/live-config.js";

describe("TradingView live market subscriptions", () => {
  it("parses exchange-qualified symbols using the final colon as timeframe separator", () => {
    expect(parseSubscriptions("NASDAQ:AAPL:15m,BINANCE:BTCUSDT:1h")).toEqual([
      { symbol: "NASDAQ:AAPL", timeframe: "15m" },
      { symbol: "BINANCE:BTCUSDT", timeframe: "1h" },
    ]);
  });

  it("rejects unqualified symbols because live data is TradingView-only", () => {
    expect(() => parseSubscriptions("BTCUSDT:15m")).toThrow(/exchange-qualified/);
  });
});
