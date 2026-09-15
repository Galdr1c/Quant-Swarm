import type { OHLCV } from "@quant-swarm/shared";

// ─── Provider Interface ───────────────────────────────────────────────────────

export interface MarketDataProvider {
  readonly name: string;
  getHistoricalOHLCV(
    symbol: string,
    timeframe: string,
    limit: number
  ): Promise<OHLCV[]>;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export { SyntheticMarketDataProvider } from "./synthetic.js";
export type { SyntheticConfig } from "./synthetic.js";
