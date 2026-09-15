import {
  KimiResearchAgent,
  MockResearchAgent,
  OpenAIResearchAgent,
  type ResearchAgent,
  type ResearchContext,
} from "@quant-swarm/ai-orchestrator";
import { SyntheticMarketDataProvider } from "@quant-swarm/market-data";
import { JsonlResearchLedger } from "@quant-swarm/research-ledger";
import type { CandidateEvent, OHLCV } from "@quant-swarm/shared";
import { HttpResearchQuantClient, runResearchSearch } from "./research-search.js";

declare const process: {
  env: Record<string, string | undefined>;
  exitCode?: number;
};

const ENGINE_URL = process.env.QUANT_ENGINE_URL ?? "http://localhost:8420";

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${ENGINE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${path} failed (${response.status}): ${text}`);
  }
  return await response.json() as T;
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
      return new MockResearchAgent({ name: `mock-${index + 1}`, variant: index });
    }
    if (provider === "openai" || provider === "astra") {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("OPENAI_API_KEY is required for an OpenAI/Astra research agent");
      return new OpenAIResearchAgent({
        apiKey,
        model: process.env.OPENAI_RESEARCH_MODEL ?? "gpt-6-astra",
        reasoningEffort: parseOpenAIEffort(process.env.OPENAI_REASONING_EFFORT),
      });
    }
    if (provider === "kimi") {
      const apiKey = process.env.KIMI_API_KEY;
      if (!apiKey) throw new Error("KIMI_API_KEY is required for a Kimi research agent");
      return new KimiResearchAgent({
        apiKey,
        model: process.env.KIMI_RESEARCH_MODEL ?? "kimi-k3",
        reasoningEffort: parseKimiEffort(process.env.KIMI_REASONING_EFFORT),
      });
    }
    throw new Error(`Unsupported RESEARCH_PROVIDERS entry: ${provider}`);
  });
}

function parseOpenAIEffort(value: string | undefined): "low" | "medium" | "high" | "xhigh" | "max" {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max") return value;
  return "high";
}

function parseKimiEffort(value: string | undefined): "low" | "high" | "max" {
  if (value === "low" || value === "high" || value === "max") return value;
  return "high";
}

function recentContext(candles: OHLCV[], event: CandidateEvent): OHLCV[] {
  const index = candles.findIndex((candle) => candle.timestamp === event.timestamp);
  if (index < 0) return candles.slice(-300);
  return candles.slice(Math.max(0, index - 299), index + 1);
}

async function main(): Promise<void> {
  const provider = new SyntheticMarketDataProvider({
    seed: 4242,
    anomalyIndices: [500, 850, 1200, 1500],
  });
  const candles = await provider.getHistoricalOHLCV("BTCUSDT", "15m", 3000);
  const discovery = candles.slice(0, 1800);
  const validation = candles.slice(1800, 2400);
  const finalHoldout = candles.slice(2400);

  const scan = await postJson<{ events: CandidateEvent[] }>("/scan", {
    symbol: "BTCUSDT",
    candles: discovery,
    zThreshold: Number(process.env.SCANNER_Z_THRESHOLD ?? 3),
    lookbackWindow: Number(process.env.SCANNER_LOOKBACK_WINDOW ?? 100),
  });
  if (scan.events.length === 0) throw new Error("Research discovery scanner produced no candidate events");
  const event = [...scan.events].sort((a, b) => b.score - a.score)[0];

  const agents = createAgents(process.env.RESEARCH_PROVIDERS ?? "mock,mock,mock");
  const context: ResearchContext = {
    recentCandles: recentContext(discovery, event),
    relatedEvents: scan.events.slice(-20),
    researchConstraints: [
      "Generate hypotheses only; do not claim backtest performance.",
      "Do not request credentials or propose direct order execution.",
      "Use only indicators/operators supported by the Strategy DSL.",
    ],
  };

  const runId = process.env.RESEARCH_RUN_ID ?? `research-${Date.now()}`;
  const ledger = new JsonlResearchLedger(
    process.env.RESEARCH_LEDGER_PATH ?? ".data/research-ledger.jsonl"
  );
  const quant = new HttpResearchQuantClient(ENGINE_URL);
  const result = await runResearchSearch({
    event,
    context,
    agents,
    validationCandles: validation,
    finalHoldoutCandles: finalHoldout,
    ledger,
    quant,
    options: {
      runId,
      annualization: 365.25 * 24 * 4,
      coordinator: {
        maxConcurrency: Number(process.env.RESEARCH_MAX_CONCURRENCY ?? 3),
        timeoutMs: Number(process.env.RESEARCH_AGENT_TIMEOUT_MS ?? 90_000),
      },
      purgedCv: {
        nSplits: Number(process.env.RESEARCH_CV_SPLITS ?? 5),
        purgeBars: Number(process.env.RESEARCH_PURGE_BARS ?? 1),
        embargoBars: Number(process.env.RESEARCH_EMBARGO_BARS ?? 1),
      },
    },
  });

  console.log(`[research] run=${result.runId}`);
  console.log(`[research] candidate=${event.type} score=${event.score.toFixed(3)}`);
  console.log(`[research] successfulTrials=${result.trialEvaluations.length} agentFailures=${result.agentFailures.length} evaluationFailures=${result.evaluationFailures.length}`);
  console.log(`[research] selected=${result.selectedStrategy.id} validationSharpe=${result.validationBacktest.sharpe.toFixed(3)}`);
  console.log(`[research] finalHoldoutSharpe=${result.finalHoldoutBacktest.sharpe.toFixed(3)} verdict=${result.researchValidation.overallVerdict}`);
  console.log("[research] observation/research only; no orders were created");

  console.log(JSON.stringify({
    runId: result.runId,
    selectedTrialId: result.selectedTrialId,
    selectedStrategyId: result.selectedStrategy.id,
    validation: {
      sharpe: result.validationBacktest.sharpe,
      netReturn: result.validationBacktest.netReturn,
      maxDrawdown: result.validationBacktest.maxDrawdown,
    },
    finalHoldout: {
      sharpe: result.finalHoldoutBacktest.sharpe,
      netReturn: result.finalHoldoutBacktest.netReturn,
      maxDrawdown: result.finalHoldoutBacktest.maxDrawdown,
    },
    researchValidation: result.researchValidation,
    agentFailures: result.agentFailures,
    evaluationFailures: result.evaluationFailures,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
