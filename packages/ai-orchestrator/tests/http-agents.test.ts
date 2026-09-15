import { describe, expect, it, vi } from "vitest";
import {
  KimiResearchAgent,
  OpenAIResearchAgent,
  parseHypothesis,
} from "../src/http-agents.js";
import type { CandidateEvent } from "@quant-swarm/shared";

const event: CandidateEvent = {
  symbol: "BTCUSDT",
  type: "ORDERBOOK_IMBALANCE",
  score: 0.61,
  timestamp: 1_700_000_000_000,
  metadata: { orderBookImbalance: 0.61 },
};

const rawHypothesis = {
  strategy: {
    id: "btc-rsi-test",
    name: "BTC RSI Test",
    market: { symbol: "BTCUSDT", timeframe: "15m" },
    indicators: [{ id: "rsi", type: "RSI", params: { length: 14 } }],
    entry: { operator: "AND", rules: [{ left: "rsi", operator: "<", right: 30 }] },
    exit: { operator: "OR", rules: [{ left: "rsi", operator: ">", right: 55 }] },
    risk: { stopLossPct: 2, takeProfitPct: 4, maxPositionPct: 3 },
  },
  confidence: 0.62,
  reasoning: "A falsifiable mean-reversion hypothesis.",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenAIResearchAgent", () => {
  it("uses Responses API, store=false and structured JSON output", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ id: "resp_123", output_text: JSON.stringify(rawHypothesis) })
    );
    const agent = new OpenAIResearchAgent({
      apiKey: "test-openai-key",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const controller = new AbortController();

    const result = await agent.investigate(event, { recentCandles: [] }, { signal: controller.signal });
    expect(result.strategy.id).toBe("btc-rsi-test");
    expect(result.provenance).toMatchObject({ provider: "openai", model: "gpt-6-astra", responseId: "resp_123" });

    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://api.openai.com/v1/responses");
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
    const request = JSON.parse(String(init.body));
    expect(request).toMatchObject({
      model: "gpt-6-astra",
      store: false,
      reasoning: { effort: "high" },
    });
    expect(request.text.format.type).toBe("json_schema");
  });
});

describe("KimiResearchAgent", () => {
  it("uses the OpenAI-compatible chat endpoint with JSON mode", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ id: "kimi_123", choices: [{ message: { content: JSON.stringify(rawHypothesis) } }] })
    );
    const agent = new KimiResearchAgent({
      apiKey: "test-kimi-key",
      fetchImpl: fetchImpl as typeof fetch,
      reasoningEffort: "max",
    });

    const result = await agent.investigate(event, { recentCandles: [] });
    expect(result.provenance).toMatchObject({ provider: "kimi", model: "kimi-k3", responseId: "kimi_123" });
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://api.moonshot.ai/v1/chat/completions");
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    const request = JSON.parse(String(init.body));
    expect(request.reasoning_effort).toBe("max");
    expect(request.response_format).toEqual({ type: "json_object" });
  });
});

describe("parseHypothesis", () => {
  it("rejects model output that violates the local Strategy DSL", () => {
    const invalid = {
      ...rawHypothesis,
      strategy: {
        ...rawHypothesis.strategy,
        entry: { operator: "AND", rules: [{ left: "missingIndicator", operator: ">", right: 1 }] },
      },
    };

    expect(() => parseHypothesis(JSON.stringify(invalid), {
      provider: "test",
      model: "test-model",
      promptVersion: "test-v1",
    })).toThrow(/local DSL validation/);
  });
});
