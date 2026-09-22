import type { OHLCV } from "@quant-swarm/shared";

export type ExchangeName = "tradingview" | "synthetic";

export interface MarketCandle extends OHLCV {
  exchange: ExchangeName;
  symbol: string;
  timeframe: string;
  closed: boolean;
}

export interface CandleSubscription {
  symbol: string;
  timeframe: string;
}

export interface CandleStreamOptions {
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  backfillLimit?: number;
}

export interface CandleStream {
  close(): void;
  readonly closed: boolean;
}

export type CandleHandler = (candle: MarketCandle) => void | Promise<void>;

export interface StreamingMarketDataProvider {
  readonly name: ExchangeName;
  getHistoricalOHLCV(
    symbol: string,
    timeframe: string,
    limit: number
  ): Promise<OHLCV[]>;
  subscribeCandles(
    subscriptions: CandleSubscription[],
    handler: CandleHandler,
    options?: CandleStreamOptions
  ): CandleStream;
}
