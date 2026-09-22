import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  KimiResearchAgent,
  MockResearchAgent,
  OpenAIResearchAgent,
  type ResearchAgent,
  type ResearchContext,
} from "@quant-swarm/ai-orchestrator";
import {
  TradingViewMarketDataProvider,
  type CandleSubscription,
} from "@quant-swarm/market-data";
import { MemoryResearchLedger } from "@quant-swarm/research-ledger";
import type { CandidateEvent, OHLCV } from "@quant-swarm/shared";
import { parseSubscriptions, parseTradingViewSession } from "./live-config.js";
import { HttpResearchQuantClient, runResearchSearch } from "./research-search.js";
import {
  annualizationForTimeframe,
  buildUniverseReport,
  downsampleSeries,
  type UniverseBacktestSnapshot,
  type UniverseResearchResult,
} from "./universe-report.js";

declare const process: {
  env: Record<string, string | undefined>;
  exitCode?: number;
};

const ENGINE_URL = process.env.QUANT_ENGINE_URL ?? "http://localhost:8420";
const DEFAULT_UNIVERSE = [
  "BINANCE:BTCUSDT:4h",
  "BINANCE:ETHUSDT:4h",
  "NASDAQ:AAPL:1h",
  "NASDAQ:NVDA:1h",
  "NASDAQ:MSFT:1h",
  "OANDA:EURUSD:1h",
  "OANDA:USDJPY:1h",
  "TVC:GOLD:4h",
].join(",");

async function main(): Promise<void> {
  const subscriptions = parseSubscriptions(
    process.env.UNIVERSE_SUBSCRIPTIONS ?? DEFAULT_UNIVERSE
  );
  const historyBars = integerEnv("UNIVERSE_HISTORY_BARS", 800, 240, 5000);
  const concurrency = integerEnv("UNIVERSE_CONCURRENCY", 2, 1, 8);
  const zThreshold = numberEnv("UNIVERSE_Z_THRESHOLD", 2.5, 0.5, 20);
  const lookbackWindow = integerEnv("SCANNER_LOOKBACK_WINDOW", 100, 10, 5000);
  const reportPath = process.env.UNIVERSE_REPORT_PATH ?? ".data/universe-report.json";

  const provider = new TradingViewMarketDataProvider({
    token: process.env.TRADINGVIEW_SESSION_ID,
    signature: process.env.TRADINGVIEW_SESSION_SIGNATURE,
    session: parseTradingViewSession(process.env.TRADINGVIEW_MARKET_SESSION),
    includeCurrentHistoricalBar: false,
  });
  const quant = new HttpResearchQuantClient(ENGINE_URL);
  const agents = createAgents(process.env.RESEARCH_PROVIDERS ?? "mock,mock,mock");
  const startedAt = Date.now();

  console.log(
    "[universe] source=TradingView assets=" + subscriptions.length +
    " historyBars=" + historyBars + " concurrency=" + concurrency
  );

  const results = await mapWithConcurrency(
    subscriptions,
    concurrency,
    async (subscription, index) => researchAsset({
      subscription,
      index,
      provider,
      quant,
      agents,
      historyBars,
      zThreshold,
      lookbackWindow,
      startedAt,
    })
  );

  const report = buildUniverseReport(results);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log("[universe] report=" + reportPath);
  console.log(
    "[universe] completed=" + report.summary.completed + "/" + report.summary.assets +
    " pass=" + report.summary.pass +
    " review=" + report.summary.review +
    " fail=" + report.summary.fail +
    " positiveHoldout=" + report.summary.positiveHoldoutRate.toFixed(1) + "%"
  );
  report.results.forEach((row, index) => {
    const holdout = row.finalHoldout;
    console.log(
      "[universe] #" + (index + 1) + " " + row.symbol + " " + row.timeframe +
      " status=" + row.status +
      " verdict=" + (row.verdict ?? "-") +
      " sharpe=" + (holdout ? holdout.sharpe.toFixed(2) : "-") +
      " return=" + (holdout ? holdout.netReturn.toFixed(2) : "-") + "%" +
      " dd=" + (holdout ? holdout.maxDrawdown.toFixed(2) : "-") + "%"
    );
  });
  console.log("[universe] research-only; no orders were created");
}

async function researchAsset(params: {
  subscription: CandleSubscription;
  index: number;
  provider: TradingViewMarketDataProvider;
  quant: HttpResearchQuantClient;
  agents: readonly ResearchAgent[];
  historyBars: number;
  zThreshold: number;
  lookbackWindow: number;
  startedAt: number;
}): Promise<UniverseResearchResult> {
  const { subscription } = params;
  const label = subscription.symbol + " " + subscription.timeframe;

  try {
    console.log("[universe] loading " + label);
    const candles = await params.provider.getHistoricalOHLCV(
      subscription.symbol,
      subscription.timeframe,
      params.historyBars
    );
    const split = splitCandles(candles);
    const scan = await postJson<{ events: CandidateEvent[] }>("/scan", {
      symbol: subscription.symbol,
      candles: split.discovery,
      zThreshold: params.zThreshold,
      lookbackWindow: Math.min(
        params.lookbackWindow,
        Math.max(10, split.discovery.length - 2)
      ),
    });

    if (scan.events.length === 0) {
      console.log("[universe] no signal " + label);
      return {
        symbol: subscription.symbol,
        timeframe: subscription.timeframe,
        status: "NO_SIGNAL",
      };
    }

    const event = [...scan.events].sort((a, b) =>
      b.score - a.score || b.timestamp - a.timestamp
    )[0];

    const context: ResearchContext = {
      recentCandles: recentContext(split.discovery, event),
      relatedEvents: scan.events.slice(-20),
      targetMarket: {
        symbol: subscription.symbol,
        timeframe: subscription.timeframe,
      },
      researchConstraints: [
        "Generate hypotheses only; do not claim backtest performance.",
        "Target exactly " + subscription.symbol + " on " + subscription.timeframe + ".",
        "Do not request credentials or propose direct order execution.",
        "Use only indicators/operators supported by the Strategy DSL.",
      ],
    };

    const runId = [
      "universe",
      String(params.startedAt),
      String(params.index + 1),
      slug(subscription.symbol),
      slug(subscription.timeframe),
    ].join("-");

    const annualizationOverride = Number(process.env.UNIVERSE_ANNUALIZATION);
    const annualization =
      Number.isFinite(annualizationOverride) && annualizationOverride > 0
        ? annualizationOverride
        : annualizationForTimeframe(subscription.timeframe);

    const result = await runResearchSearch({
      event,
      context,
      agents: params.agents,
      regimeCalibrationCandles: split.discovery,
      validationCandles: split.validation,
      finalHoldoutCandles: split.holdout,
      ledger: new MemoryResearchLedger(),
      quant: params.quant,
      options: {
        runId,
        annualization,
        coordinator: {
          maxConcurrency: integerEnv("RESEARCH_MAX_CONCURRENCY", 3, 1, 16),
          timeoutMs: integerEnv("RESEARCH_AGENT_TIMEOUT_MS", 90_000, 1000, 600_000),
        },
        purgedCv: {
          nSplits: integerEnv("RESEARCH_CV_SPLITS", 5, 2, 20),
          purgeBars: integerEnv("RESEARCH_PURGE_BARS", 1, 0, 100),
          embargoBars: integerEnv("RESEARCH_EMBARGO_BARS", 1, 0, 100),
        },
        regime: {
          lookback: integerEnv("RESEARCH_REGIME_LOOKBACK", 48, 3, 5000),
          volatilityQuantile: numberEnv(
            "RESEARCH_REGIME_VOL_QUANTILE",
            0.67,
            0.5,
            0.95
          ),
          trendQuantile: numberEnv(
            "RESEARCH_REGIME_TREND_QUANTILE",
            0.67,
            0.5,
            0.95
          ),
        },
      },
    });

    console.log(
      "[universe] researched " + label +
      " verdict=" + result.researchValidation.overallVerdict
    );

    return {
      symbol: subscription.symbol,
      timeframe: subscription.timeframe,
      status: "COMPLETED",
      runId,
      candidate: {
        type: event.type,
        score: event.score,
        timestamp: event.timestamp,
      },
      selectedStrategy: {
        id: result.selectedStrategy.id,
        name: result.selectedStrategy.name,
      },
      validation: snapshot(result.validationBacktest),
      finalHoldout: snapshot(result.finalHoldoutBacktest),
      verdict: result.researchValidation.overallVerdict,
      checks: result.researchValidation.checks,
      equityCurve: downsampleSeries(result.finalHoldoutBacktest.equityCurve, 80),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[universe] failed " + label + ": " + message);
    return {
      symbol: subscription.symbol,
      timeframe: subscription.timeframe,
      status: "ERROR",
      error: message.slice(0, 1000),
    };
  }
}

function snapshot(result: {
  netReturn: number;
  annualReturn: number;
  sharpe: number;
  sortino: number;
  maxDrawdown: number;
  profitFactor: number;
  expectancy: number;
  totalTrades: number;
  winRate: number;
}): UniverseBacktestSnapshot {
  return {
    netReturn: result.netReturn,
    annualReturn: result.annualReturn,
    sharpe: result.sharpe,
    sortino: result.sortino,
    maxDrawdown: result.maxDrawdown,
    profitFactor: result.profitFactor,
    expectancy: result.expectancy,
    totalTrades: result.totalTrades,
    winRate: result.winRate,
  };
}

function splitCandles(candles: OHLCV[]): {
  discovery: OHLCV[];
  validation: OHLCV[];
  holdout: OHLCV[];
} {
  if (candles.length < 240) {
    throw new Error(
      "At least 240 closed candles are required; received " + candles.length
    );
  }
  const discoveryEnd = Math.floor(candles.length * 0.6);
  const validationEnd = Math.floor(candles.length * 0.8);
  const discovery = candles.slice(0, discoveryEnd);
  const validation = candles.slice(discoveryEnd, validationEnd);
  const holdout = candles.slice(validationEnd);
  if (validation.length < 40 || holdout.length < 40) {
    throw new Error(
      "Validation and final holdout slices require at least 40 candles each"
    );
  }
  return { discovery, validation, holdout };
}

function recentContext(candles: OHLCV[], event: CandidateEvent): OHLCV[] {
  const index = candles.findIndex((candle) => candle.timestamp === event.timestamp);
  if (index < 0) return candles.slice(-300);
  return candles.slice(Math.max(0, index - 299), index + 1);
}

function createAgents(raw: string): ResearchAgent[] {
  const providers = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (providers.length < 2) {
    throw new Error("RESEARCH_PROVIDERS must contain at least two agents/trials");
  }

  return providers.map((provider, index) => {
    if (provider === "mock") {
      return new MockResearchAgent({
        name: "mock-" + (index + 1),
        variant: index,
      });
    }
    if (provider === "openai" || provider === "astra") {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error(
          "OPENAI_API_KEY is required for an OpenAI/Astra research agent"
        );
      }
      return new OpenAIResearchAgent({
        apiKey,
        model: process.env.OPENAI_RESEARCH_MODEL ?? "gpt-6-astra",
        reasoningEffort: parseOpenAIEffort(process.env.OPENAI_REASONING_EFFORT),
      });
    }
    if (provider === "kimi") {
      const apiKey = process.env.KIMI_API_KEY;
      if (!apiKey) {
        throw new Error("KIMI_API_KEY is required for a Kimi research agent");
      }
      return new KimiResearchAgent({
        apiKey,
        model: process.env.KIMI_RESEARCH_MODEL ?? "kimi-k3",
        reasoningEffort: parseKimiEffort(process.env.KIMI_REASONING_EFFORT),
      });
    }
    throw new Error("Unsupported RESEARCH_PROVIDERS entry: " + provider);
  });
}

function parseOpenAIEffort(
  value: string | undefined
): "low" | "medium" | "high" | "xhigh" | "max" {
  if (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  ) {
    return value;
  }
  return "high";
}

function parseKimiEffort(
  value: string | undefined
): "low" | "high" | "max" {
  if (value === "low" || value === "high" || value === "max") return value;
  return "high";
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(ENGINE_URL + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(path + " failed (" + response.status + "): " + text);
  }
  return (await response.json()) as T;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;

  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= values.length) return;
        results[index] = await worker(values[index], index);
      }
    }
  );

  await Promise.all(workers);
  return results;
}

function integerEnv(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      name + " must be an integer in [" + minimum + ", " + maximum + "]"
    );
  }
  return value;
}

function numberEnv(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(
      name + " must be numeric in [" + minimum + ", " + maximum + "]"
    );
  }
  return value;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "asset"
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
