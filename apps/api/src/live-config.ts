import type { CandleSubscription } from "@quant-swarm/market-data";

export function parseSubscriptions(raw: string): CandleSubscription[] {
  return raw.split(",").map((item) => {
    const value = item.trim();
    const separator = value.lastIndexOf(":");
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error(`Invalid MARKET_SUBSCRIPTIONS item: ${item}`);
    }
    const symbol = value.slice(0, separator).trim();
    const timeframe = value.slice(separator + 1).trim();
    if (!symbol || !timeframe) throw new Error(`Invalid MARKET_SUBSCRIPTIONS item: ${item}`);
    return { symbol: symbol.toUpperCase(), timeframe };
  });
}

export function parseTradingViewSession(value: string | undefined): "regular" | "extended" | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "regular" || normalized === "extended") return normalized;
  throw new Error("TRADINGVIEW_MARKET_SESSION must be regular or extended");
}
