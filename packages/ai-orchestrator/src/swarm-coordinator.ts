import type { CandidateEvent } from "@quant-swarm/shared";
import type {
  ResearchAgent,
  ResearchContext,
  ResearchHypothesis,
} from "./index.js";

export interface MultiAgentCoordinatorOptions {
  /** Maximum number of provider calls in flight at once. */
  maxConcurrency?: number;
  /** Per-agent wall-clock timeout. The underlying fetch is aborted on timeout. */
  timeoutMs?: number;
  /** Optional cap on successful hypotheses returned from one fan-out. */
  maxHypotheses?: number;
}

export interface CoordinatedHypothesis {
  agentName: string;
  hypothesis: ResearchHypothesis;
  durationMs: number;
}

export interface AgentFailure {
  agentName: string;
  message: string;
  timedOut: boolean;
}

export interface ResearchCoordinationResult {
  hypotheses: CoordinatedHypothesis[];
  failures: AgentFailure[];
  attemptedAgents: number;
  durationMs: number;
}

/**
 * Bounded fan-out coordinator for independent hypothesis generation.
 *
 * The coordinator deliberately does not rank, grade, backtest or risk-check
 * hypotheses. Those responsibilities stay in deterministic downstream layers.
 * One provider failure never promotes another agent's output to "validated";
 * it is merely recorded as a failed research attempt.
 */
export class MultiAgentResearchCoordinator {
  private readonly maxConcurrency: number;
  private readonly timeoutMs: number;
  private readonly maxHypotheses: number;

  constructor(
    private readonly agents: readonly ResearchAgent[],
    options: MultiAgentCoordinatorOptions = {}
  ) {
    if (agents.length === 0) throw new Error("At least one research agent is required");
    this.maxConcurrency = boundedInteger(options.maxConcurrency ?? 4, 1, agents.length);
    this.timeoutMs = boundedInteger(options.timeoutMs ?? 90_000, 1, 10 * 60_000);
    this.maxHypotheses = boundedInteger(
      options.maxHypotheses ?? agents.length,
      1,
      agents.length
    );
  }

  async investigate(
    event: CandidateEvent,
    context: ResearchContext
  ): Promise<ResearchCoordinationResult> {
    const startedAt = Date.now();
    const hypotheses: CoordinatedHypothesis[] = [];
    const failures: AgentFailure[] = [];
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        if (hypotheses.length >= this.maxHypotheses) return;
        const index = cursor++;
        if (index >= this.agents.length) return;
        const agent = this.agents[index];
        const callStartedAt = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
          const hypothesis = await agent.investigate(event, context, {
            signal: controller.signal,
          });
          if (hypotheses.length < this.maxHypotheses) {
            hypotheses.push({
              agentName: agent.name,
              hypothesis,
              durationMs: Date.now() - callStartedAt,
            });
          }
        } catch (error) {
          const timedOut = controller.signal.aborted;
          failures.push({
            agentName: agent.name,
            timedOut,
            message: timedOut
              ? `Research request exceeded ${this.timeoutMs}ms timeout`
              : errorMessage(error),
          });
        } finally {
          clearTimeout(timer);
        }
      }
    };

    await Promise.all(
      Array.from({ length: this.maxConcurrency }, () => worker())
    );

    return {
      hypotheses,
      failures,
      attemptedAgents: Math.min(cursor, this.agents.length),
      durationMs: Date.now() - startedAt,
    };
  }
}

function boundedInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
