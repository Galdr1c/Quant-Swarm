import type { CandidateEvent } from "@quant-swarm/shared";
import type {
  IndicatorDefinition,
  IndicatorType,
  StrategyDefinition,
} from "@quant-swarm/strategy-schema";
import type { ResearchAgent, ResearchContext, ResearchHypothesis } from "./index.js";

function indicator(
  id: string,
  type: IndicatorType,
  params: Record<string, string | number | boolean>
): IndicatorDefinition {
  return { id, type, params };
}

const TEMPLATES: Record<string, (event: CandidateEvent) => StrategyDefinition> = {
  VOLUME_ANOMALY: (event) => ({
    id: `${event.symbol.toLowerCase()}-vol-ema-${Date.now()}`,
    name: `${event.symbol} Volume Breakout EMA`,
    market: { symbol: event.symbol, timeframe: "15m" },
    indicators: [
      indicator("emaFast", "EMA", { length: 9 }),
      indicator("emaSlow", "EMA", { length: 21 }),
      indicator("rsi", "RSI", { length: 14 }),
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
      indicator("rsi", "RSI", { length: 14 }),
      indicator("bbands", "BBANDS", { length: 20, stddev: 2 }),
      indicator("atr", "ATR", { length: 14 }),
    ],
    entry: {
      operator: "AND",
      rules: [{ left: "rsi", operator: "<", right: 30 }],
    },
    exit: {
      operator: "OR",
      rules: [{ left: "rsi", operator: ">", right: 55 }],
    },
    risk: { stopLossPct: 2.0, takeProfitPct: 4.0, maxPositionPct: 3 },
  }),

  VOLATILITY_EXPANSION: (event) => ({
    id: `${event.symbol.toLowerCase()}-supertrend-${Date.now()}`,
    name: `${event.symbol} Supertrend Momentum`,
    market: { symbol: event.symbol, timeframe: "15m" },
    indicators: [
      indicator("supertrend", "SUPERTREND", { factor: 3, atrLength: 10 }),
      indicator("emaFast", "EMA", { length: 9 }),
      indicator("emaSlow", "EMA", { length: 21 }),
    ],
    entry: {
      operator: "AND",
      rules: [{ left: "emaFast", operator: "crosses_above", right: "emaSlow" }],
    },
    exit: {
      operator: "OR",
      rules: [{ left: "emaFast", operator: "crosses_below", right: "emaSlow" }],
    },
    risk: { stopLossPct: 2.5, takeProfitPct: 5.0, maxPositionPct: 4 },
  }),
};

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
