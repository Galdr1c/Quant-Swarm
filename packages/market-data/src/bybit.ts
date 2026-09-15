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
  WebSocketLike,
} from "./types.js";

export interface BybitProviderOptions {
  category?: "spot" | "linear" | "inverse";
  restBaseUrl?: string;
  wsBaseUrl?: string;
  fetchImpl?: FetchLike;
  webSocketFactory?: WebSocketFactory;
}

export class BybitMarketDataProvider implements StreamingMarketDataProvider {
  readonly name = "bybit" as const;
  private readonly category: "spot" | "linear" | "inverse";
  private readonly restBaseUrl: string;
  private readonly wsBaseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly webSocketFactory: WebSocketFactory;

  constructor(options: BybitProviderOptions = {}) {
    this.category = options.category ?? "linear";
    this.restBaseUrl = options.restBaseUrl ?? "https://api.bybit.com";
    this.wsBaseUrl = options.wsBaseUrl ?? `wss://stream.bybit.com/v5/public/${this.category}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.webSocketFactory = options.webSocketFactory ?? createDefaultWebSocketFactory();
  }

  async getHistoricalOHLCV(symbol: string, timeframe: string, limit: number): Promise<OHLCV[]> {
    const url = new URL("/v5/market/kline", this.restBaseUrl);
    url.searchParams.set("category", this.category);
    url.searchParams.set("symbol", symbol.toUpperCase());
    url.searchParams.set("interval", toBybitInterval(timeframe));
    url.searchParams.set("limit", String(Math.max(1, Math.min(limit, 1000))));
    const response = await this.fetchImpl(url);
    if (!response.ok) throw new Error(`Bybit klines failed: ${response.status}`);
    const body = (await response.json()) as any;
    if (body?.retCode !== 0 || !Array.isArray(body?.result?.list)) {
      throw new Error(`Bybit klines error: ${body?.retMsg ?? "invalid response"}`);
    }
    return body.result.list.map(parseBybitRestKline).sort((a: OHLCV, b: OHLCV) => a.timestamp - b.timestamp);
  }

  subscribeCandles(subscriptions: CandleSubscription[], handler: CandleHandler, options: CandleStreamOptions = {}): CandleStream {
    const adapter: ResilientStreamAdapter = {
      buildUrl: () => this.wsBaseUrl,
      onOpen: (socket: WebSocketLike, subs) => {
        socket.send(JSON.stringify({
          op: "subscribe",
          args: subs.map((s) => `kline.${toBybitInterval(s.timeframe)}.${s.symbol.toUpperCase()}`),
        }));
      },
      parseMessage: parseBybitWsMessage,
      backfill: async (sub, limit) =>
        (await this.getHistoricalOHLCV(sub.symbol, sub.timeframe, limit)).map((c) => ({
          ...c,
          exchange: "bybit" as const,
          symbol: sub.symbol.toUpperCase(),
          timeframe: sub.timeframe,
          closed: true,
        })),
    };
    return new ResilientCandleStream(adapter, subscriptions, handler, this.webSocketFactory, normalizeStreamOptions(options));
  }
}

export function toBybitInterval(timeframe: string): string {
  const map: Record<string, string> = {
    "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30",
    "1h": "60", "2h": "120", "4h": "240", "6h": "360", "12h": "720",
    "1d": "D", "1w": "W", "1M": "M",
  };
  const result = map[timeframe];
  if (!result) throw new Error(`Unsupported Bybit timeframe: ${timeframe}`);
  return result;
}

export function fromBybitInterval(interval: string): string {
  const reverse: Record<string, string> = {
    "1": "1m", "3": "3m", "5": "5m", "15": "15m", "30": "30m",
    "60": "1h", "120": "2h", "240": "4h", "360": "6h", "720": "12h",
    D: "1d", W: "1w", M: "1M",
  };
  return reverse[interval] ?? interval;
}

export function parseBybitRestKline(row: any): OHLCV {
  if (!Array.isArray(row) || row.length < 6) throw new Error("Invalid Bybit kline payload");
  return {
    timestamp: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  };
}

export function parseBybitWsMessage(payload: any): MarketCandle[] {
  if (typeof payload?.topic !== "string" || !payload.topic.startsWith("kline.") || !Array.isArray(payload?.data)) return [];
  const [, interval, symbol] = payload.topic.split(".");
  return payload.data.map((row: any) => ({
    exchange: "bybit" as const,
    symbol: String(symbol).toUpperCase(),
    timeframe: fromBybitInterval(String(interval)),
    timestamp: Number(row.start),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
    closed: Boolean(row.confirm),
  }));
}
