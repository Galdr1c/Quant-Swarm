import type { OHLCV } from "@quant-swarm/shared";
import {
  createDefaultWebSocketFactory,
  normalizeStreamOptions,
  ResilientCandleStream,
  type ResilientStreamAdapter,
} from "./resilient-stream.js";
import type {
  CandleHandler,
  CandleStream,
  CandleStreamOptions,
  CandleSubscription,
  FetchLike,
  MarketCandle,
  StreamingMarketDataProvider,
  WebSocketFactory,
} from "./types.js";

export interface BinanceProviderOptions {
  restBaseUrl?: string;
  wsBaseUrl?: string;
  fetchImpl?: FetchLike;
  webSocketFactory?: WebSocketFactory;
}

export class BinanceMarketDataProvider implements StreamingMarketDataProvider {
  readonly name = "binance" as const;
  private readonly restBaseUrl: string;
  private readonly wsBaseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly webSocketFactory: WebSocketFactory;

  constructor(options: BinanceProviderOptions = {}) {
    this.restBaseUrl = options.restBaseUrl ?? "https://api.binance.com";
    this.wsBaseUrl = options.wsBaseUrl ?? "wss://stream.binance.com:9443";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.webSocketFactory = options.webSocketFactory ?? createDefaultWebSocketFactory();
  }

  async getHistoricalOHLCV(symbol: string, timeframe: string, limit: number): Promise<OHLCV[]> {
    const capped = Math.max(1, Math.min(limit, 1000));
    const url = new URL("/api/v3/klines", this.restBaseUrl);
    url.searchParams.set("symbol", symbol.toUpperCase());
    url.searchParams.set("interval", timeframe);
    url.searchParams.set("limit", String(capped));
    const response = await this.fetchImpl(url);
    if (!response.ok) throw new Error(`Binance klines failed: ${response.status}`);
    const rows = (await response.json()) as unknown[];
    return rows.map(parseBinanceRestKline);
  }

  subscribeCandles(
    subscriptions: CandleSubscription[],
    handler: CandleHandler,
    options: CandleStreamOptions = {}
  ): CandleStream {
    const adapter: ResilientStreamAdapter = {
      buildUrl: (subs) => buildBinanceStreamUrl(this.wsBaseUrl, subs),
      parseMessage: parseBinanceWsMessage,
      backfill: async (sub, limit) =>
        (await this.getHistoricalOHLCV(sub.symbol, sub.timeframe, limit)).map((c) => ({
          ...c,
          exchange: "binance" as const,
          symbol: sub.symbol.toUpperCase(),
          timeframe: sub.timeframe,
          closed: true,
        })),
    };
    return new ResilientCandleStream(
      adapter,
      subscriptions,
      handler,
      this.webSocketFactory,
      normalizeStreamOptions(options)
    );
  }
}

export function buildBinanceStreamUrl(baseUrl: string, subscriptions: CandleSubscription[]): string {
  const streams = subscriptions
    .map((s) => `${s.symbol.toLowerCase()}@kline_${s.timeframe}`)
    .join("/");
  return `${baseUrl.replace(/\/$/, "")}/stream?streams=${streams}`;
}

export function parseBinanceRestKline(row: any): OHLCV {
  if (!Array.isArray(row) || row.length < 6) throw new Error("Invalid Binance kline payload");
  return {
    timestamp: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  };
}

export function parseBinanceWsMessage(payload: any): MarketCandle[] {
  const data = payload?.data ?? payload;
  const k = data?.k;
  if (!k || data?.e !== "kline") return [];
  return [{
    exchange: "binance",
    symbol: String(k.s ?? data.s).toUpperCase(),
    timeframe: String(k.i),
    timestamp: Number(k.t),
    open: Number(k.o),
    high: Number(k.h),
    low: Number(k.l),
    close: Number(k.c),
    volume: Number(k.v),
    closed: Boolean(k.x),
  }];
}
