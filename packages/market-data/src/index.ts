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
export * from "./tradingview.js";
export { SyntheticMarketDataProvider } from "./synthetic.js";
export type { SyntheticConfig } from "./synthetic.js";
