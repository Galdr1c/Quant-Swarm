import type { CandidateEvent } from "@quant-swarm/shared";
import type { StrategyDefinition } from "@quant-swarm/strategy-schema";
import type { ResearchAgent, ResearchContext, ResearchHypothesis } from "./index.js";

// ─── Predefined Strategy Templates ───────────────────────────────────────────

const TEMPLATES: Record<string, (event: CandidateEvent) => StrategyDefinition> = {
  VOLUME_ANOMALY: (event) => ({
    id: `${event.symbol.toLowerCase()}-vol-ema-${Date.now()}`,
    name: `${event.symbol} Volume Breakout EMA`,
    market: { symbol: event.symbol, timeframe: "15m" },
    indicators: [
      { id: "emaFast", type: "EMA", params: { length: 9 } },
      { id: "emaSlow", type: "EMA", params: { length: 21 } },
      { id: "rsi", type: "RSI", params: { length: 14 } },
    ],
    entry: {
      operator: "AND",
      rules: [
        { left: "emaFast", operator: "crosses_above", right: "emaSlow" },
        { left: "rsi", operator: "<", right: 70 },
      ],
    },
    exit: {
      operator: "OR",
      rules: [
        { left: "emaFast", operator: "crosses_below", right: "emaSlow" },
        { left: "rsi", operator: ">", right: 80 },
      ],
    },
    risk: { stopLossPct: 1.5, takeProfitPct: 3.0, maxPositionPct: 5 },
  }),

  PRICE_DISLOCATION: (event) => ({
    id: `${event.symbol.toLowerCase()}-rsi-reversion-${Date.now()}`,
    name: `${event.symbol} RSI Mean Reversion`,
    market: { symbol: event.symbol, timeframe: "15m" },
    indicators: [
      { id: "rsi", type: "RSI", params: { length: 14 } },
      { id: "bbands", type: "BBANDS", params: { length: 20, stddev: 2 } },
      { id: "atr", type: "ATR", params: { length: 14 } },
    ],
    entry: {
      operator: "AND",
      rules: [
        { left: "rsi", operator: "<", right: 30 },
      ],
    },
    exit: {
      operator: "OR",
      rules: [
        { left: "rsi", operator: ">", right: 55 },
      ],
    },
    risk: { stopLossPct: 2.0, takeProfitPct: 4.0, maxPositionPct: 3 },
  }),

  VOLATILITY_EXPANSION: (event) => ({
    id: `${event.symbol.toLowerCase()}-supertrend-${Date.now()}`,
    name: `${event.symbol} Supertrend Momentum`,
    market: { symbol: event.symbol, timeframe: "15m" },
    indicators: [
      { id: "supertrend", type: "SUPERTREND", params: { factor: 3, atrLength: 10 } },
      { id: "emaFast", type: "EMA", params: { length: 9 } },
      { id: "emaSlow", type: "EMA", params: { length: 21 } },
    ],
    entry: {
      operator: "AND",
      rules: [
        { left: "emaFast", operator: "crosses_above", right: "emaSlow" },
      ],
    },
    exit: {
      operator: "OR",
      rules: [
        { left: "emaFast", operator: "crosses_below", right: "emaSlow" },
      ],
    },
    risk: { stopLossPct: 2.5, takeProfitPct: 5.0, maxPositionPct: 4 },
  }),
};

// ─── Mock Research Agent ──────────────────────────────────────────────────────

/**
 * Deterministic mock agent for milestone 1.
 * Returns predefined strategy templates based on event type.
 * No LLM calls — pure template lookup.
 */
export class MockResearchAgent implements ResearchAgent {
  readonly name = "mock-research-agent";

  async investigate(
    event: CandidateEvent,
    _context: ResearchContext
  ): Promise<ResearchHypothesis> {
    const templateFn = TEMPLATES[event.type] ?? TEMPLATES.VOLUME_ANOMALY;
    const strategy = templateFn(event);

    return {
      strategy,
      confidence: 0.65,
      reasoning: `[MOCK] Generated ${strategy.name} in response to ${event.type} event (score: ${event.score.toFixed(2)}) on ${event.symbol}.`,
    };
  }
}
