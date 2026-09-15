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
  /** Deterministically computed market-intelligence snapshot/summary */
  marketIntelligence?: Record<string, string | number | boolean | null>;
  /** Hard research constraints supplied by the application, not the model */
  researchConstraints?: string[];
}

// ─── Research Hypothesis ──────────────────────────────────────────────────────

export interface ResearchAgentProvenance {
  provider: string;
  model: string;
  promptVersion: string;
  responseId?: string;
  latencyMs?: number;
}

export interface ResearchHypothesis {
  /** Generated strategy in DSL format */
  strategy: StrategyDefinition;
  /** Agent's confidence in this hypothesis (0-1); not a probability of profit */
  confidence: number;
  /** Human-readable reasoning; never used as a backtest/statistical result */
  reasoning: string;
  /** Auditable provider/model metadata. No secrets or hidden chain of thought. */
  provenance?: ResearchAgentProvenance;
}

export interface ResearchInvocationOptions {
  /** Cancellation signal owned by the application/coordinator. */
  signal?: AbortSignal;
}

// ─── Research Agent Interface ─────────────────────────────────────────────────

/**
 * Interface for research agents.
 *
 * Agents generate hypotheses only. They do not backtest, validate, grade risk,
 * or execute orders. Provider implementations must pass model output through
 * local Strategy DSL validation before returning it to the application.
 */
export interface ResearchAgent {
  readonly name: string;

  investigate(
    event: CandidateEvent,
    context: ResearchContext,
    options?: ResearchInvocationOptions
  ): Promise<ResearchHypothesis>;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export { MockResearchAgent } from "./mock-agent.js";
export type { MockResearchAgentOptions } from "./mock-agent.js";
export {
  KimiResearchAgent,
  OpenAIResearchAgent,
  buildResearchInput,
  parseHypothesis,
} from "./http-agents.js";
export type {
  AgentFetch,
  KimiResearchAgentOptions,
  OpenAIResearchAgentOptions,
} from "./http-agents.js";
export { MultiAgentResearchCoordinator } from "./swarm-coordinator.js";
export type {
  AgentFailure,
  CoordinatedHypothesis,
  MultiAgentCoordinatorOptions,
  ResearchCoordinationResult,
} from "./swarm-coordinator.js";
