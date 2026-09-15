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

export interface HyperliquidProviderOptions {
  restUrl?: string;
  wsUrl?: string;
  fetchImpl?: FetchLike;
  webSocketFactory?: WebSocketFactory;
}

export class HyperliquidMarketDataProvider implements StreamingMarketDataProvider {
  readonly name = "hyperliquid" as const;
  private readonly restUrl: string;
  private readonly wsUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly webSocketFactory: WebSocketFactory;

  constructor(options: HyperliquidProviderOptions = {}) {
    this.restUrl = options.restUrl ?? "https://api.hyperliquid.xyz/info";
    this.wsUrl = options.wsUrl ?? "wss://api.hyperliquid.xyz/ws";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.webSocketFactory = options.webSocketFactory ?? createDefaultWebSocketFactory();
  }

  async getHistoricalOHLCV(symbol: string, timeframe: string, limit: number): Promise<OHLCV[]> {
    const intervalMs = timeframeToMs(timeframe);
    const capped = Math.max(1, Math.min(limit, 5000));
    const endTime = Date.now();
    const startTime = endTime - intervalMs * capped;
    const response = await this.fetchImpl(this.restUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "candleSnapshot",
        req: { coin: symbol.toUpperCase(), interval: timeframe, startTime, endTime },
      }),
    });
    if (!response.ok) throw new Error(`Hyperliquid candleSnapshot failed: ${response.status}`);
    const rows = (await response.json()) as unknown[];
    return rows.slice(-capped).map(parseHyperliquidCandle);
  }

  subscribeCandles(subscriptions: CandleSubscription[], handler: CandleHandler, options: CandleStreamOptions = {}): CandleStream {
    const adapter: ResilientStreamAdapter = {
      buildUrl: () => this.wsUrl,
      onOpen: (socket: WebSocketLike, subs) => {
        for (const sub of subs) {
          socket.send(JSON.stringify({
            method: "subscribe",
            subscription: { type: "candle", coin: sub.symbol.toUpperCase(), interval: sub.timeframe },
          }));
        }
      },
      parseMessage: parseHyperliquidWsMessage,
      backfill: async (sub, limit) =>
        (await this.getHistoricalOHLCV(sub.symbol, sub.timeframe, limit)).map((c) => ({
          ...c,
          exchange: "hyperliquid" as const,
          symbol: sub.symbol.toUpperCase(),
          timeframe: sub.timeframe,
          closed: true,
        })),
    };
    return new ResilientCandleStream(adapter, subscriptions, handler, this.webSocketFactory, normalizeStreamOptions(options));
  }
}

export function parseHyperliquidCandle(row: any): OHLCV {
  if (!row || row.t === undefined) throw new Error("Invalid Hyperliquid candle payload");
  return {
    timestamp: Number(row.t),
    open: Number(row.o),
    high: Number(row.h),
    low: Number(row.l),
    close: Number(row.c),
    volume: Number(row.v),
  };
}

export function parseHyperliquidWsMessage(payload: any): MarketCandle[] {
  if (payload?.channel !== "candle") return [];
  const rows = Array.isArray(payload.data) ? payload.data : [payload.data];
  return rows.filter(Boolean).map((row: any) => ({
    exchange: "hyperliquid" as const,
    symbol: String(row.s).toUpperCase(),
    timeframe: String(row.i),
    timestamp: Number(row.t),
    open: Number(row.o),
    high: Number(row.h),
    low: Number(row.l),
    close: Number(row.c),
    volume: Number(row.v),
    closed: row.T !== undefined ? Date.now() >= Number(row.T) : false,
  }));
}

export function timeframeToMs(timeframe: string): number {
  const match = timeframe.match(/^(\d+)(m|h|d|w|M)$/);
  if (!match) throw new Error(`Unsupported timeframe: ${timeframe}`);
  const value = Number(match[1]);
  const unit = match[2];
  const unitMs: Record<string, number> = {
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
    M: 2_592_000_000,
  };
  return value * unitMs[unit];
}
