import { TradingViewMarketDataProvider } from "@quant-swarm/market-data";
import { parseSubscriptions, parseTradingViewSession } from "./live-config.js";
import { HttpScannerClient, MultiSymbolLiveScanner } from "./live-scanner.js";

declare const process: {
  env: Record<string, string | undefined>;
  on(event: string, handler: () => void): void;
  exitCode?: number;
};

async function main(): Promise<void> {
  const subscriptions = parseSubscriptions(
    process.env.MARKET_SUBSCRIPTIONS ?? "BINANCE:BTCUSDT:15m,NASDAQ:AAPL:15m"
  );
  const engineUrl = process.env.QUANT_ENGINE_URL ?? "http://localhost:8420";

  const provider = new TradingViewMarketDataProvider({
    token: process.env.TRADINGVIEW_SESSION_ID,
    signature: process.env.TRADINGVIEW_SESSION_SIGNATURE,
    session: parseTradingViewSession(process.env.TRADINGVIEW_MARKET_SESSION),
    includeCurrentHistoricalBar: false,
  });

  const scanner = new MultiSymbolLiveScanner(provider, new HttpScannerClient(engineUrl), {
    bufferSize: Number(process.env.MARKET_BUFFER_SIZE ?? 500),
    lookbackWindow: Number(process.env.SCANNER_LOOKBACK_WINDOW ?? 100),
    zThreshold: Number(process.env.SCANNER_Z_THRESHOLD ?? 3),
    onCandidate: (event, candle) => {
      console.log(JSON.stringify({
        stage: "live-candidate",
        source: candle.exchange,
        symbol: candle.symbol,
        timeframe: candle.timeframe,
        candleTimestamp: candle.timestamp,
        event,
      }));
    },
  });

  await scanner.start(subscriptions);
  console.log(`[live] TradingView: ${subscriptions.map((s) => `${s.symbol}:${s.timeframe}`).join(", ")}`);
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
