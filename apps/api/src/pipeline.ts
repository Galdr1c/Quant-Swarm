import { SyntheticMarketDataProvider } from "@quant-swarm/market-data";
import { MockResearchAgent } from "@quant-swarm/ai-orchestrator";
import { validateStrategy } from "@quant-swarm/strategy-schema";
import {
  DEFAULT_RISK_LIMITS,
  RiskEngine,
  type PortfolioState,
  type ProposedOrder,
} from "@quant-swarm/risk-contracts";
import type {
  BacktestResult,
  CandidateEvent,
  OHLCV,
  ValidationReport,
} from "@quant-swarm/shared";

declare const process: { env: Record<string, string | undefined> };

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

  return (await response.json()) as T;
}

function recentContext(candles: OHLCV[], event: CandidateEvent): OHLCV[] {
  const idx = candles.findIndex((c) => c.timestamp === event.timestamp);
  if (idx < 0) return candles.slice(-200);
  return candles.slice(Math.max(0, idx - 199), idx + 1);
}

async function main(): Promise<void> {
  console.log("[quant-swarm] milestone 1 pipeline\n");

  const provider = new SyntheticMarketDataProvider({
    seed: 42,
    anomalyIndices: [1050, 1200, 1350],
  });
  const candles = await provider.getHistoricalOHLCV("BTCUSDT", "15m", 1500);
  console.log(`[market] loaded ${candles.length} synthetic BTCUSDT candles`);

  const scan = await postJson<{ events: CandidateEvent[] }>("/scan", {
    symbol: "BTCUSDT",
    candles,
    zThreshold: 3,
    lookbackWindow: 100,
  });

  if (scan.events.length === 0) {
    throw new Error("scanner produced no candidate events");
  }

  const event = [...scan.events].sort((a, b) => b.score - a.score)[0];
  console.log(`[scanner] ${event.type} score=${event.score.toFixed(2)}`);

  const agent = new MockResearchAgent();
  const hypothesis = await agent.investigate(event, {
    recentCandles: recentContext(candles, event),
  });

  const schemaResult = validateStrategy(hypothesis.strategy);
  if (!schemaResult.valid || !schemaResult.strategy) {
    throw new Error(`strategy schema rejected: ${schemaResult.errors.join("; ")}`);
  }
  console.log(`[research] ${schemaResult.strategy.name}`);

  const backtest = await postJson<BacktestResult>("/backtest", {
    strategy: schemaResult.strategy,
    candles,
  });
  console.log(
    `[backtest] trades=${backtest.totalTrades} net=${backtest.netReturn.toFixed(2)}% ` +
      `sharpe=${backtest.sharpe.toFixed(2)} dd=${backtest.maxDrawdown.toFixed(2)}%`
  );

  const validation = await postJson<ValidationReport>("/validate", {
    result: backtest,
  });
  console.log(`[validation] ${validation.overallVerdict}`);

  const equity = 100_000;
  const last = candles[candles.length - 1];
  const state: PortfolioState = {
    equity,
    peakEquity: equity,
    dailyPnl: 0,
    dailyPnlPct: 0,
    drawdownPct: 0,
    totalExposurePct: 0,
    symbolExposures: new Map(),
  };
  const order: ProposedOrder = {
    symbol: schemaResult.strategy.market.symbol,
    side: "BUY",
    quantity:
      (equity * schemaResult.strategy.risk.maxPositionPct) /
      100 /
      last.close,
    price: last.close,
    leverage: 1,
    strategyId: schemaResult.strategy.id,
  };

  const riskEngine = new RiskEngine(DEFAULT_RISK_LIMITS, "shadow", false);
  const risk = riskEngine.evaluateOrder(order, state);
  const approved = validation.overallVerdict === "PASS" && risk.approved;
  const decision = approved ? "SHADOW_APPROVED" : "SHADOW_REJECTED";

  console.log(`[risk] ${risk.approved ? "PASS" : risk.reason}`);
  console.log(`\n[decision] ${decision}`);

  console.log(
    JSON.stringify(
      {
        candidate: event,
        strategyId: schemaResult.strategy.id,
        backtest,
        validation,
        risk,
        decision,
      },
      null,
      2
    )
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
