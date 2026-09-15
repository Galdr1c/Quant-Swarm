import { describe, expect, it, vi } from "vitest";
import {
  BinanceMarketDataProvider,
  buildBinanceStreamUrl,
  parseBinanceWsMessage,
} from "../src/binance.js";
import {
  BybitMarketDataProvider,
  parseBybitWsMessage,
  toBybitInterval,
} from "../src/bybit.js";
import {
  HyperliquidMarketDataProvider,
  parseHyperliquidWsMessage,
} from "../src/hyperliquid.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("Binance adapter", () => {
  it("builds a combined multi-symbol kline stream URL", () => {
    expect(buildBinanceStreamUrl("wss://stream.binance.com:9443", [
      { symbol: "BTCUSDT", timeframe: "15m" },
      { symbol: "ETHUSDT", timeframe: "1h" },
    ])).toBe("wss://stream.binance.com:9443/stream?streams=btcusdt@kline_15m/ethusdt@kline_1h");
  });

  it("normalizes websocket klines", () => {
    const [candle] = parseBinanceWsMessage({ data: { e: "kline", s: "BTCUSDT", k: {
      t: 1000, s: "BTCUSDT", i: "15m", o: "100", h: "110", l: "90", c: "105", v: "12", x: true,
    } } });
    expect(candle).toMatchObject({ exchange: "binance", symbol: "BTCUSDT", timeframe: "15m", close: 105, closed: true });
  });

  it("fetches historical spot klines", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([[1000, "1", "2", "0.5", "1.5", "10"]]));
    const provider = new BinanceMarketDataProvider({ fetchImpl: fetchImpl as any, webSocketFactory: (() => { throw new Error("unused"); }) as any });
    const rows = await provider.getHistoricalOHLCV("BTCUSDT", "15m", 10);
    expect(rows[0]).toEqual({ timestamp: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/api/v3/klines");
  });
});

describe("Bybit adapter", () => {
  it("maps canonical timeframes to V5 intervals", () => {
    expect(toBybitInterval("15m")).toBe("15");
    expect(toBybitInterval("4h")).toBe("240");
  });

  it("uses confirm as the closed-candle flag", () => {
    const [candle] = parseBybitWsMessage({
      topic: "kline.15.BTCUSDT",
      data: [{ start: 1000, open: "100", high: "110", low: "90", close: "105", volume: "12", confirm: true }],
    });
    expect(candle).toMatchObject({ exchange: "bybit", symbol: "BTCUSDT", timeframe: "15m", closed: true });
  });

  it("sorts REST klines ascending", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ retCode: 0, result: { list: [
      [2000, "2", "3", "1", "2.5", "20"],
      [1000, "1", "2", "0.5", "1.5", "10"],
    ] } }));
    const provider = new BybitMarketDataProvider({ fetchImpl: fetchImpl as any, webSocketFactory: (() => { throw new Error("unused"); }) as any });
    const rows = await provider.getHistoricalOHLCV("BTCUSDT", "15m", 10);
    expect(rows.map((x) => x.timestamp)).toEqual([1000, 2000]);
  });
});

describe("Hyperliquid adapter", () => {
  it("normalizes candle websocket payloads", () => {
    const [candle] = parseHyperliquidWsMessage({ channel: "candle", data: {
      t: 1000, T: Date.now() - 1, s: "BTC", i: "15m", o: "100", h: "110", l: "90", c: "105", v: "12",
    } });
    expect(candle).toMatchObject({ exchange: "hyperliquid", symbol: "BTC", timeframe: "15m", close: 105, closed: true });
  });

  it("posts candleSnapshot for historical data", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ t: 1000, o: "1", h: "2", l: "0.5", c: "1.5", v: "10" }]));
    const provider = new HyperliquidMarketDataProvider({ fetchImpl: fetchImpl as any, webSocketFactory: (() => { throw new Error("unused"); }) as any });
    const rows = await provider.getHistoricalOHLCV("BTC", "15m", 10);
    expect(rows[0].close).toBe(1.5);
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(String(init.body)).toContain("candleSnapshot");
  });
});
