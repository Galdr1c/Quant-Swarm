import {
  normalizeTradingViewSymbol,
  type CandleSubscription,
} from "@quant-swarm/market-data";

export function parseSubscriptions(raw: string): CandleSubscription[] {
  const subscriptions = raw.split(",").map((item) => {
    const value = item.trim();
    const separator = value.lastIndexOf(":");
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error(`Invalid MARKET_SUBSCRIPTIONS item: ${item}`);
    }
    const symbol = normalizeTradingViewSymbol(value.slice(0, separator));
    const timeframe = value.slice(separator + 1).trim();
    if (!timeframe) throw new Error(`Invalid MARKET_SUBSCRIPTIONS item: ${item}`);
    return { symbol, timeframe };
  });
  if (subscriptions.length === 0) throw new Error("MARKET_SUBSCRIPTIONS cannot be empty");
  return subscriptions;
}

export function parseTradingViewSession(value: string | undefined): "regular" | "extended" | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "regular" || normalized === "extended") return normalized;
  throw new Error("TRADINGVIEW_MARKET_SESSION must be regular or extended");
}
