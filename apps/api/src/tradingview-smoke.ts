import {
  TradingViewMarketDataProvider,
  searchTradingViewMarkets,
} from "@quant-swarm/market-data";

declare const process: {
  env: Record<string, string | undefined>;
  exitCode?: number;
};

async function main(): Promise<void> {
  const provider = new TradingViewMarketDataProvider({
    token: process.env.TRADINGVIEW_SESSION_ID,
    signature: process.env.TRADINGVIEW_SESSION_SIGNATURE,
    requestTimeoutMs: Number(process.env.TRADINGVIEW_SMOKE_TIMEOUT_MS ?? 20_000),
    settleMs: 250,
  });

  const [btc, aaplSearch] = await Promise.all([
    provider.getHistoricalOHLCV("BINANCE:BTCUSDT", "15m", 5),
    searchTradingViewMarkets("NASDAQ:AAPL", "stock"),
  ]);

  if (btc.length < 3) throw new Error(`TradingView BTC smoke returned only ${btc.length} candles`);
  if (!btc.every((row) => row.timestamp > 0 && Number.isFinite(row.close))) {
    throw new Error("TradingView BTC smoke returned invalid OHLCV rows");
  }

  const aapl = aaplSearch.find((row) => row.id.toUpperCase() === "NASDAQ:AAPL")
    ?? aaplSearch.find((row) => row.symbol.toUpperCase() === "AAPL");
  if (!aapl) throw new Error("TradingView symbol search did not resolve AAPL");

  const stocks = await provider.getHistoricalOHLCV(aapl.id, "1d", 5);
  if (stocks.length < 3) throw new Error(`TradingView stock smoke returned only ${stocks.length} candles`);

  console.log(JSON.stringify({
    provider: provider.name,
    anonymous: !process.env.TRADINGVIEW_SESSION_ID,
    crypto: {
      symbol: "BINANCE:BTCUSDT",
      candles: btc.length,
      latestClose: btc.at(-1)?.close,
    },
    stock: {
      symbol: aapl.id,
      candles: stocks.length,
      latestClose: stocks.at(-1)?.close,
    },
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
