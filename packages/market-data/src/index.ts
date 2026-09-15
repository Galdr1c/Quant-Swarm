import type { OHLCV } from "@quant-swarm/shared";

export interface MarketDataProvider {
  readonly name: string;
  getHistoricalOHLCV(
    symbol: string,
    timeframe: string,
    limit: number
  ): Promise<OHLCV[]>;
}

export * from "./types.js";
export * from "./resilient-stream.js";
export * from "./intelligence.js";
export * from "./tradingview.js";
export { SyntheticMarketDataProvider } from "./synthetic.js";
export type { SyntheticConfig } from "./synthetic.js";
export { BinanceMarketDataProvider } from "./binance.js";
export type { BinanceProviderOptions } from "./binance.js";
export { BybitMarketDataProvider } from "./bybit.js";
export type { BybitProviderOptions } from "./bybit.js";
export { HyperliquidMarketDataProvider } from "./hyperliquid.js";
export type { HyperliquidProviderOptions } from "./hyperliquid.js";
