import type { CandidateEvent, OHLCV } from "@quant-swarm/shared";
import type { StrategyDefinition } from "@quant-swarm/strategy-schema";

// ─── Research Context ─────────────────────────────────────────────────────────

export interface ResearchContext {
  /** Recent OHLCV candles around the event */
  recentCandles: OHLCV[];
  /** Current market regime estimate */
  regime?: "trending" | "ranging" | "volatile";
  /** Other recent candidate events */
  relatedEvents?: CandidateEvent[];
}

// ─── Research Hypothesis ──────────────────────────────────────────────────────

export interface ResearchHypothesis {
  /** Generated strategy in DSL format */
  strategy: StrategyDefinition;
  /** Agent's confidence in this hypothesis (0-1) */
  confidence: number;
  /** Human-readable reasoning */
  reasoning: string;
}

// ─── Research Agent Interface ─────────────────────────────────────────────────

/**
 * Interface for research agents.
 * Implementations: MockResearchAgent (milestone 1), OpenAIResearchAgent (phase 3), KimiResearchAgent (phase 3)
 */
export interface ResearchAgent {
  readonly name: string;

  investigate(
    event: CandidateEvent,
    context: ResearchContext
  ): Promise<ResearchHypothesis>;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export { MockResearchAgent } from "./mock-agent.js";
