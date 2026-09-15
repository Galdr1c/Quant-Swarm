import type { CandidateEvent } from "@quant-swarm/shared";
import type {
  IndicatorDefinition,
  IndicatorType,
  StrategyDefinition,
} from "@quant-swarm/strategy-schema";
import type { ResearchAgent, ResearchContext, ResearchHypothesis } from "./index.js";

export interface MockResearchAgentOptions {
  name?: string;
  variant?: number;
}

function indicator(
  id: string,
  type: IndicatorType,
  params: Record<string, string | number | boolean>
): IndicatorDefinition {
  return { id, type, params };
}

function variantInt(variant: number, step: number, max: number): number {
  return Math.min(max, Math.max(0, Math.floor(variant))) * step;
}

const TEMPLATES: Record<string, (event: CandidateEvent, variant: number) => StrategyDefinition> = {
  VOLUME_ANOMALY: (event, variant) => {
    const delta = variantInt(variant, 2, 4);
    return {
      id: `${event.symbol.toLowerCase()}-vol-ema-v${variant}-${event.timestamp}`,
      name: `${event.symbol} Volume Breakout EMA v${variant}`,
      market: { symbol: event.symbol, timeframe: "15m" },
      indicators: [
        indicator("emaFast", "EMA", { length: 9 + delta }),
        indicator("emaSlow", "EMA", { length: 21 + delta * 2 }),
        indicator("rsi", "RSI", { length: 14 + variantInt(variant, 1, 4) }),
      ],
      entry: {
        operator: "AND",
        rules: [
          { left: "emaFast", operator: "crosses_above", right: "emaSlow" },
          { left: "rsi", operator: "<", right: Math.max(58, 70 - delta) },
        ],
      },
      exit: {
        operator: "OR",
        rules: [
          { left: "emaFast", operator: "crosses_below", right: "emaSlow" },
          { left: "rsi", operator: ">", right: Math.min(88, 80 + delta) },
        ],
      },
      risk: {
        stopLossPct: 1.5 + Math.min(variant, 3) * 0.25,
        takeProfitPct: 3.0 + Math.min(variant, 3) * 0.5,
        maxPositionPct: 5,
      },
    };
  },

  PRICE_DISLOCATION: (event, variant) => {
    const delta = variantInt(variant, 2, 4);
    return {
      id: `${event.symbol.toLowerCase()}-rsi-reversion-v${variant}-${event.timestamp}`,
      name: `${event.symbol} RSI Mean Reversion v${variant}`,
      market: { symbol: event.symbol, timeframe: "15m" },
      indicators: [
        indicator("rsi", "RSI", { length: 12 + delta }),
        indicator("bbands", "BBANDS", { length: 18 + delta, stddev: 2 }),
        indicator("atr", "ATR", { length: 12 + delta }),
      ],
      entry: {
        operator: "AND",
        rules: [{ left: "rsi", operator: "<", right: Math.min(38, 28 + delta) }],
      },
      exit: {
        operator: "OR",
        rules: [{ left: "rsi", operator: ">", right: Math.min(65, 52 + delta) }],
      },
      risk: {
        stopLossPct: 1.75 + Math.min(variant, 3) * 0.25,
        takeProfitPct: 3.5 + Math.min(variant, 3) * 0.5,
        maxPositionPct: 3,
      },
    };
  },

  VOLATILITY_EXPANSION: (event, variant) => {
    const delta = variantInt(variant, 2, 4);
    return {
      id: `${event.symbol.toLowerCase()}-supertrend-v${variant}-${event.timestamp}`,
      name: `${event.symbol} Supertrend Momentum v${variant}`,
      market: { symbol: event.symbol, timeframe: "15m" },
      indicators: [
        indicator("supertrend", "SUPERTREND", {
          factor: 2.5 + Math.min(variant, 3) * 0.25,
          atrLength: 10 + delta,
        }),
        indicator("emaFast", "EMA", { length: 9 + delta }),
        indicator("emaSlow", "EMA", { length: 21 + delta * 2 }),
      ],
      entry: {
        operator: "AND",
        rules: [{ left: "emaFast", operator: "crosses_above", right: "emaSlow" }],
      },
      exit: {
        operator: "OR",
        rules: [{ left: "emaFast", operator: "crosses_below", right: "emaSlow" }],
      },
      risk: {
        stopLossPct: 2.0 + Math.min(variant, 3) * 0.25,
        takeProfitPct: 4.0 + Math.min(variant, 3) * 0.5,
        maxPositionPct: 4,
      },
    };
  },
};

export class MockResearchAgent implements ResearchAgent {
  readonly name: string;
  private readonly variant: number;

  constructor(options: MockResearchAgentOptions = {}) {
    this.variant = Math.max(0, Math.floor(options.variant ?? 0));
    this.name = options.name ?? `mock-research-agent-v${this.variant}`;
  }

  async investigate(
    event: CandidateEvent,
    _context: ResearchContext
  ): Promise<ResearchHypothesis> {
    const templateFn = TEMPLATES[event.type] ?? TEMPLATES.VOLUME_ANOMALY;
    const strategy = templateFn(event, this.variant);

    return {
      strategy,
      confidence: Math.max(0.45, 0.65 - this.variant * 0.03),
      reasoning: `[MOCK] Generated ${strategy.name} in response to ${event.type} event (score: ${event.score.toFixed(2)}) on ${event.symbol}.`,
      provenance: {
        provider: "mock",
        model: "deterministic-template",
        promptVersion: `mock-v${this.variant}`,
      },
    };
  }
}
