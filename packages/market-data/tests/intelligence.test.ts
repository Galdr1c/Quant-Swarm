import { describe, expect, it, vi } from "vitest";
import {
  BinanceFuturesIntelligenceProvider,
  BybitIntelligenceProvider,
  HyperliquidIntelligenceProvider,
  basisBps,
  normalizeBookLevels,
  normalizeHyperliquidCoin,
  parseBinanceLiquidationMessage,
  parseBybitLiquidationMessage,
} from "../src/intelligence.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("market intelligence normalization", () => {
  it("normalizes book levels and basis", () => {
    expect(normalizeBookLevels([["100", "2"], ["99", "3"]])).toEqual([
      { price: 100, size: 2, notionalUsd: 200 },
      { price: 99, size: 3, notionalUsd: 297 },
    ]);
    expect(basisBps(101, 100)).toBeCloseTo(100);
  });

  it("maps common Hyperliquid quote symbols to native coin names", () => {
    expect(normalizeHyperliquidCoin("BTCUSDT")).toBe("BTC");
    expect(normalizeHyperliquidCoin("ETHUSD")).toBe("ETH");
    expect(normalizeHyperliquidCoin("HYPE")).toBe("HYPE");
  });
});

describe("Binance futures intelligence", () => {
  it("combines depth, premium index and open interest", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/fapi/v1/depth")) {
        return jsonResponse({ T: 1_000, bids: [["100", "2"]], asks: [["101", "1"]] });
      }
      if (url.includes("/fapi/v1/premiumIndex")) {
        return jsonResponse({ time: 1_001, markPrice: "100.5", indexPrice: "100", lastFundingRate: "0.0007", nextFundingTime: 2_000 });
      }
      if (url.includes("/fapi/v1/openInterest")) {
        return jsonResponse({ time: 1_002, openInterest: "20" });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const provider = new BinanceFuturesIntelligenceProvider({
      fetchImpl: fetchImpl as any,
      webSocketFactory: (() => { throw new Error("unused"); }) as any,
    });
    const snapshot = await provider.getSnapshot("BTCUSDT");

    expect(snapshot).toMatchObject({
      exchange: "binance",
      symbol: "BTCUSDT",
      bestBid: 100,
      bestAsk: 101,
      fundingRate: 0.0007,
      openInterest: 20,
      markPrice: 100.5,
      indexPrice: 100,
    });
    expect(snapshot.bidDepthUsd).toBe(200);
    expect(snapshot.askDepthUsd).toBe(101);
    expect(snapshot.orderBookImbalance).toBeCloseTo((200 - 101) / 301);
    expect(snapshot.openInterestUsd).toBeCloseTo(2_010);
    expect(snapshot.basisBps).toBeCloseTo(50);
  });

  it("normalizes forceOrder liquidations", () => {
    const [event] = parseBinanceLiquidationMessage({
      data: { e: "forceOrder", E: 1000, o: { s: "BTCUSDT", S: "SELL", q: "2", ap: "100" } },
    });
    expect(event).toEqual({
      exchange: "binance",
      symbol: "BTCUSDT",
      timestamp: 1000,
      side: "LONG",
      price: 100,
      size: 2,
      notionalUsd: 200,
    });
  });
});

describe("Bybit intelligence", () => {
  it("combines V5 orderbook and ticker fields", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v5/market/orderbook")) {
        return jsonResponse({ retCode: 0, time: 2_000, result: { b: [["200", "3"]], a: [["202", "2"]], ts: 1_999 } });
      }
      if (url.includes("/v5/market/tickers")) {
        return jsonResponse({ retCode: 0, time: 2_001, result: { list: [{
          markPrice: "201",
          indexPrice: "200",
          fundingRate: "-0.0008",
          nextFundingTime: "3000",
          openInterest: "10",
          openInterestValue: "2010",
        }] } });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const provider = new BybitIntelligenceProvider({
      fetchImpl: fetchImpl as any,
      webSocketFactory: (() => { throw new Error("unused"); }) as any,
    });
    const snapshot = await provider.getSnapshot("BTCUSDT");
    expect(snapshot).toMatchObject({
      exchange: "bybit",
      fundingRate: -0.0008,
      openInterest: 10,
      openInterestUsd: 2010,
      markPrice: 201,
      indexPrice: 200,
    });
    expect(snapshot.basisBps).toBeCloseTo(50);
  });

  it("normalizes allLiquidation events using Bybit position-side semantics", () => {
    const events = parseBybitLiquidationMessage({
      topic: "allLiquidation.BTCUSDT",
      ts: 1000,
      data: [
        { T: 999, s: "BTCUSDT", S: "Buy", v: "2", p: "100" },
        { T: 1000, s: "BTCUSDT", S: "Sell", v: "1", p: "101" },
      ],
    });
    expect(events.map((event) => event.side)).toEqual(["LONG", "SHORT"]);
    expect(events.map((event) => event.notionalUsd)).toEqual([200, 101]);
  });
});

describe("Hyperliquid intelligence", () => {
  it("joins l2Book with metaAndAssetCtxs", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.type === "l2Book") {
        expect(body.coin).toBe("BTC");
        return jsonResponse({ time: 3_000, levels: [
          [{ px: "300", sz: "2", n: 2 }],
          [{ px: "301", sz: "1", n: 1 }],
        ] });
      }
      if (body.type === "metaAndAssetCtxs") {
        return jsonResponse([
          { universe: [{ name: "BTC", szDecimals: 5 }, { name: "ETH", szDecimals: 4 }] },
          [
            { funding: "0.0001", openInterest: "5", markPx: "300.5", oraclePx: "300" },
            { funding: "0", openInterest: "1", markPx: "10", oraclePx: "10" },
          ],
        ]);
      }
      throw new Error(`unexpected body: ${String(init?.body)}`);
    });

    const provider = new HyperliquidIntelligenceProvider({ fetchImpl: fetchImpl as any });
    const snapshot = await provider.getSnapshot("BTCUSDT");
    expect(snapshot).toMatchObject({
      exchange: "hyperliquid",
      symbol: "BTC",
      fundingRate: 0.0001,
      openInterest: 5,
      markPrice: 300.5,
      indexPrice: 300,
      liquidationLongUsd: null,
      liquidationShortUsd: null,
    });
    expect(snapshot.openInterestUsd).toBeCloseTo(1502.5);
  });
});
