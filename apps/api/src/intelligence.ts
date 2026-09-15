import {
  BinanceFuturesIntelligenceProvider,
  BybitIntelligenceProvider,
  HyperliquidIntelligenceProvider,
  type MarketIntelligenceProvider,
} from "@quant-swarm/market-data";
import { MarketIntelligenceScanner } from "./intelligence-scanner.js";

declare const process: {
  env: Record<string, string | undefined>;
  on(event: string, handler: () => void): void;
  exitCode?: number;
};

function parseSymbols(raw: string): string[] {
  return [...new Set(raw.split(",").map((item) => item.trim().toUpperCase()).filter(Boolean))];
}

function createProvider(name: string): MarketIntelligenceProvider {
  switch (name.toLowerCase()) {
    case "binance":
      return new BinanceFuturesIntelligenceProvider({
        restBaseUrl: process.env.BINANCE_FUTURES_REST_URL,
        wsBaseUrl: process.env.BINANCE_FUTURES_WS_URL,
        depthLimit: numberEnv("INTELLIGENCE_DEPTH_LEVELS", 50),
        liquidationWindowMs: numberEnv("LIQUIDATION_WINDOW_MS", 60_000),
      });
    case "bybit":
      return new BybitIntelligenceProvider({
        category: (process.env.BYBIT_CATEGORY as "linear" | "inverse" | undefined) ?? "linear",
        restBaseUrl: process.env.BYBIT_REST_URL,
        wsBaseUrl: process.env.BYBIT_WS_URL,
        depthLimit: numberEnv("INTELLIGENCE_DEPTH_LEVELS", 50),
        liquidationWindowMs: numberEnv("LIQUIDATION_WINDOW_MS", 60_000),
      });
    case "hyperliquid":
      return new HyperliquidIntelligenceProvider({
        restUrl: process.env.HYPERLIQUID_INFO_URL,
        depthLimit: numberEnv("INTELLIGENCE_DEPTH_LEVELS", 20),
      });
    default:
      throw new Error(`Unsupported INTELLIGENCE_PROVIDER: ${name}`);
  }
}

async function main(): Promise<void> {
  const providerName = process.env.INTELLIGENCE_PROVIDER ?? process.env.MARKET_PROVIDER ?? "binance";
  const defaultSymbols = providerName.toLowerCase() === "hyperliquid" ? "BTC,ETH" : "BTCUSDT,ETHUSDT";
  const symbols = parseSymbols(process.env.INTELLIGENCE_SYMBOLS ?? defaultSymbols);
  if (symbols.length === 0) throw new Error("INTELLIGENCE_SYMBOLS cannot be empty");

  const provider = createProvider(providerName);
  const scanner = new MarketIntelligenceScanner(provider, {
    pollIntervalMs: numberEnv("INTELLIGENCE_POLL_MS", 5_000),
    historySize: numberEnv("INTELLIGENCE_HISTORY_SIZE", 120),
    orderBookImbalanceThreshold: numberEnv("ORDERBOOK_IMBALANCE_THRESHOLD", 0.35),
    fundingRateThreshold: numberEnv("FUNDING_RATE_THRESHOLD", 0.0005),
    openInterestChangePctThreshold: numberEnv("OPEN_INTEREST_CHANGE_PCT_THRESHOLD", 2),
    openInterestLookbackSamples: numberEnv("OPEN_INTEREST_LOOKBACK_SAMPLES", 12),
    basisBpsThreshold: numberEnv("BASIS_BPS_THRESHOLD", 10),
    spreadBpsThreshold: numberEnv("SPREAD_BPS_THRESHOLD", 5),
    liquidationUsdThreshold: numberEnv("LIQUIDATION_USD_THRESHOLD", 1_000_000),
    volatilityBpsThreshold: numberEnv("INTELLIGENCE_VOLATILITY_BPS_THRESHOLD", 25),
    volatilityLookbackSamples: numberEnv("INTELLIGENCE_VOLATILITY_LOOKBACK_SAMPLES", 20),
    candidateCooldownMs: numberEnv("INTELLIGENCE_CANDIDATE_COOLDOWN_MS", 60_000),
    onSnapshot: (snapshot) => {
      if (process.env.INTELLIGENCE_LOG_SNAPSHOTS === "true") {
        console.log(JSON.stringify({ stage: "intelligence-snapshot", snapshot }));
      }
    },
    onCandidate: (event, snapshot) => {
      console.log(JSON.stringify({
        stage: "intelligence-candidate",
        exchange: snapshot.exchange,
        symbol: snapshot.symbol,
        event,
      }));
    },
    onError: (symbol, error) => {
      console.error(JSON.stringify({
        stage: "intelligence-error",
        exchange: provider.name,
        symbol,
        error: error instanceof Error ? error.message : String(error),
      }));
    },
  });

  await scanner.start(symbols);
  console.log(`[intelligence] ${provider.name}: ${symbols.join(", ")}`);
  console.log("[intelligence] observation-only; no orders or authenticated exchange endpoints are used");

  const shutdown = () => {
    scanner.stop();
    console.log("[intelligence] stopped");
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be numeric`);
  return value;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
