import {
  BinanceMarketDataProvider,
  BybitMarketDataProvider,
  HyperliquidMarketDataProvider,
  TradingViewMarketDataProvider,
  type CandleSubscription,
  type StreamingMarketDataProvider,
} from "@quant-swarm/market-data";
import { HttpScannerClient, MultiSymbolLiveScanner } from "./live-scanner.js";

declare const process: {
  env: Record<string, string | undefined>;
  on(event: string, handler: () => void): void;
  exitCode?: number;
};

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

function createProvider(name: string): StreamingMarketDataProvider {
  switch (name.toLowerCase()) {
    case "tradingview":
      return new TradingViewMarketDataProvider({
        token: process.env.TRADINGVIEW_SESSION_ID,
        signature: process.env.TRADINGVIEW_SESSION_SIGNATURE,
        session: parseTradingViewSession(process.env.TRADINGVIEW_MARKET_SESSION),
        includeCurrentHistoricalBar: false,
      });
    case "binance":
      return new BinanceMarketDataProvider();
    case "bybit":
      return new BybitMarketDataProvider({
        category: (process.env.BYBIT_CATEGORY as "spot" | "linear" | "inverse" | undefined) ?? "linear",
      });
    case "hyperliquid":
      return new HyperliquidMarketDataProvider();
    default:
      throw new Error(`Unsupported MARKET_PROVIDER: ${name}`);
  }
}

function parseTradingViewSession(value: string | undefined): "regular" | "extended" | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "regular" || normalized === "extended") return normalized;
  throw new Error("TRADINGVIEW_MARKET_SESSION must be regular or extended");
}

async function main(): Promise<void> {
  const providerName = process.env.MARKET_PROVIDER ?? "tradingview";
  const subscriptions = parseSubscriptions(
    process.env.MARKET_SUBSCRIPTIONS ?? "BINANCE:BTCUSDT:15m,NASDAQ:AAPL:15m"
  );
  const engineUrl = process.env.QUANT_ENGINE_URL ?? "http://localhost:8420";

  const provider = createProvider(providerName);
  const scanner = new MultiSymbolLiveScanner(provider, new HttpScannerClient(engineUrl), {
    bufferSize: Number(process.env.MARKET_BUFFER_SIZE ?? 500),
    lookbackWindow: Number(process.env.SCANNER_LOOKBACK_WINDOW ?? 100),
    zThreshold: Number(process.env.SCANNER_Z_THRESHOLD ?? 3),
    onCandidate: (event, candle) => {
      console.log(JSON.stringify({
        stage: "live-candidate",
        exchange: candle.exchange,
        symbol: candle.symbol,
        timeframe: candle.timeframe,
        candleTimestamp: candle.timestamp,
        event,
      }));
    },
  });

  await scanner.start(subscriptions);
  console.log(`[live] ${provider.name}: ${subscriptions.map((s) => `${s.symbol}:${s.timeframe}`).join(", ")}`);
  console.log("[live] scanner is observation-only; no orders are created");

  const shutdown = () => {
    scanner.stop();
    console.log("[live] stopped");
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
