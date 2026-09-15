import { describe, expect, it } from "vitest";
import { MultiAgentResearchCoordinator } from "../src/swarm-coordinator.js";
import type {
  ResearchAgent,
  ResearchContext,
  ResearchHypothesis,
  ResearchInvocationOptions,
} from "../src/index.js";
import type { CandidateEvent } from "@quant-swarm/shared";

const event: CandidateEvent = {
  symbol: "BTCUSDT",
  type: "PRICE_DISLOCATION",
  score: 4.2,
  timestamp: 1_700_000_000_000,
  metadata: { returnZScore: 4.2 },
};

const context: ResearchContext = { recentCandles: [] };

function hypothesis(id: string): ResearchHypothesis {
  return {
    strategy: {
      id,
      name: id,
      market: { symbol: "BTCUSDT", timeframe: "15m" },
      indicators: [{ id: "rsi", type: "RSI", params: { length: 14 } }],
      entry: { operator: "AND", rules: [{ left: "rsi", operator: "<", right: 30 }] },
      exit: { operator: "OR", rules: [{ left: "rsi", operator: ">", right: 55 }] },
      risk: { stopLossPct: 2, takeProfitPct: 4, maxPositionPct: 3 },
    },
    confidence: 0.6,
    reasoning: "test hypothesis",
  };
}

class FakeAgent implements ResearchAgent {
  constructor(
    readonly name: string,
    private readonly run: (options?: ResearchInvocationOptions) => Promise<ResearchHypothesis>
  ) {}

  investigate(
    _event: CandidateEvent,
    _context: ResearchContext,
    options?: ResearchInvocationOptions
  ): Promise<ResearchHypothesis> {
    return this.run(options);
  }
}

describe("MultiAgentResearchCoordinator", () => {
  it("bounds concurrent provider calls", async () => {
    let active = 0;
    let peak = 0;
    const agents = Array.from({ length: 6 }, (_, index) =>
      new FakeAgent(`agent-${index}`, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return hypothesis(`strategy-${index}`);
      })
    );

    const coordinator = new MultiAgentResearchCoordinator(agents, {
      maxConcurrency: 2,
      timeoutMs: 1_000,
    });
    const result = await coordinator.investigate(event, context);

    expect(result.hypotheses).toHaveLength(6);
    expect(result.failures).toEqual([]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("isolates one provider failure from successful hypotheses", async () => {
    const coordinator = new MultiAgentResearchCoordinator([
      new FakeAgent("good", async () => hypothesis("good-strategy")),
      new FakeAgent("bad", async () => { throw new Error("provider down"); }),
    ]);

    const result = await coordinator.investigate(event, context);
    expect(result.hypotheses.map((row) => row.agentName)).toEqual(["good"]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ agentName: "bad", timedOut: false });
  });

  it("aborts an agent when its timeout expires", async () => {
    const slow = new FakeAgent("slow", (options) =>
      new Promise<ResearchHypothesis>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })
    );
    const coordinator = new MultiAgentResearchCoordinator([slow], { timeoutMs: 10 });

    const result = await coordinator.investigate(event, context);
    expect(result.hypotheses).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].timedOut).toBe(true);
  });
});
