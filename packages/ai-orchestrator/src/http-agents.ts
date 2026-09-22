import type { CandidateEvent } from "@quant-swarm/shared";
import { validateStrategy } from "@quant-swarm/strategy-schema";
import type {
  ResearchAgent,
  ResearchAgentProvenance,
  ResearchContext,
  ResearchHypothesis,
  ResearchInvocationOptions,
} from "./index.js";

export type AgentFetch = typeof fetch;

export interface OpenAIResearchAgentOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  promptVersion?: string;
  fetchImpl?: AgentFetch;
}

export interface KimiResearchAgentOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  reasoningEffort?: "low" | "high" | "max";
  promptVersion?: string;
  fetchImpl?: AgentFetch;
}

interface RawHypothesis {
  strategy?: unknown;
  confidence?: unknown;
  reasoning?: unknown;
}

const HYPOTHESIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["strategy", "confidence", "reasoning"],
  properties: {
    strategy: {
      type: "object",
      additionalProperties: false,
      required: ["id", "name", "market", "indicators", "entry", "exit", "risk"],
      properties: {
        id: { type: "string", minLength: 1, maxLength: 128 },
        name: { type: "string", minLength: 1, maxLength: 256 },
        market: {
          type: "object",
          additionalProperties: false,
          required: ["symbol", "timeframe"],
          properties: {
            symbol: { type: "string", minLength: 1 },
            timeframe: { type: "string", minLength: 1 },
          },
        },
        indicators: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "type", "params"],
            properties: {
              id: { type: "string", minLength: 1, maxLength: 64 },
              type: {
                type: "string",
                enum: ["EMA", "SMA", "RSI", "ATR", "MACD", "SUPERTREND", "BBANDS", "VWAP"],
              },
              // Dynamic indicator parameters are locally validated by Zod.
              params: {
                type: "object",
                additionalProperties: {
                  anyOf: [{ type: "number" }, { type: "string" }, { type: "boolean" }],
                },
              },
            },
          },
        },
        entry: ruleGroupSchema(),
        exit: ruleGroupSchema(),
        risk: {
          type: "object",
          additionalProperties: false,
          required: ["maxPositionPct"],
          properties: {
            stopLossPct: { type: "number", exclusiveMinimum: 0, maximum: 50 },
            takeProfitPct: { type: "number", exclusiveMinimum: 0, maximum: 100 },
            maxPositionPct: { type: "number", exclusiveMinimum: 0, maximum: 100 },
          },
        },
      },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reasoning: { type: "string", minLength: 1, maxLength: 4000 },
  },
} as const;

function ruleGroupSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["operator", "rules"],
    properties: {
      operator: { type: "string", enum: ["AND", "OR"] },
      rules: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["left", "operator", "right"],
          properties: {
            left: { type: "string", minLength: 1 },
            operator: {
              type: "string",
              enum: [">", "<", ">=", "<=", "crosses_above", "crosses_below"],
            },
            right: { anyOf: [{ type: "string" }, { type: "number" }] },
          },
        },
      },
    },
  } as const;
}

const SYSTEM_PROMPT = `You are a quantitative research hypothesis generator inside a controlled research platform.
Your only task is to propose a Strategy DSL hypothesis from deterministic market evidence.
Do not claim profitability. Do not compute or invent backtest metrics, p-values, Sharpe ratios, fills, or risk approval.
Do not place orders and do not ask for credentials. The application will independently validate, backtest, statistically grade, and risk-check your proposal.
Return only the requested JSON structure. Every entry/exit rule must reference indicator IDs defined in the strategy. Keep maxPositionPct conservative.`;

export class OpenAIResearchAgent implements ResearchAgent {
  readonly name = "openai-astra";
  readonly provider = "openai";
  readonly model: string;
  readonly promptVersion: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly reasoningEffort: NonNullable<OpenAIResearchAgentOptions["reasoningEffort"]>;
  private readonly fetchImpl: AgentFetch;

  constructor(options: OpenAIResearchAgentOptions) {
    this.apiKey = requiredSecret(options.apiKey, "OpenAI API key");
    this.model = options.model ?? "gpt-6-astra";
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.reasoningEffort = options.reasoningEffort ?? "high";
    this.promptVersion = options.promptVersion ?? "research-v1";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async investigate(
    event: CandidateEvent,
    context: ResearchContext,
    options: ResearchInvocationOptions = {}
  ): Promise<ResearchHypothesis> {
    const startedAt = Date.now();
    const response = await this.fetchImpl(`${this.baseUrl}/responses`, {
      method: "POST",
      signal: options.signal,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        store: false,
        reasoning: { effort: this.reasoningEffort },
        instructions: SYSTEM_PROMPT,
        input: buildResearchInput(event, context),
        text: {
          format: {
            type: "json_schema",
            name: "quant_research_hypothesis",
            strict: false,
            schema: HYPOTHESIS_SCHEMA,
          },
        },
      }),
    });
    const body = await response.json() as any;
    if (!response.ok) throw providerError("OpenAI", response.status, body);
    const text = extractOpenAIOutputText(body);
    return parseHypothesis(text, {
      provider: this.provider,
      model: this.model,
      responseId: typeof body?.id === "string" ? body.id : undefined,
      latencyMs: Date.now() - startedAt,
      promptVersion: this.promptVersion,
    });
  }
}

export class KimiResearchAgent implements ResearchAgent {
  readonly name = "kimi-k3";
  readonly provider = "kimi";
  readonly model: string;
  readonly promptVersion: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly reasoningEffort: NonNullable<KimiResearchAgentOptions["reasoningEffort"]>;
  private readonly fetchImpl: AgentFetch;

  constructor(options: KimiResearchAgentOptions) {
    this.apiKey = requiredSecret(options.apiKey, "Kimi API key");
    this.model = options.model ?? "kimi-k3";
    this.baseUrl = (options.baseUrl ?? "https://api.moonshot.ai/v1").replace(/\/$/, "");
    this.reasoningEffort = options.reasoningEffort ?? "high";
    this.promptVersion = options.promptVersion ?? "research-v1";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async investigate(
    event: CandidateEvent,
    context: ResearchContext,
    options: ResearchInvocationOptions = {}
  ): Promise<ResearchHypothesis> {
    const startedAt = Date.now();
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      signal: options.signal,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        reasoning_effort: this.reasoningEffort,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `${buildResearchInput(event, context)}\nReturn valid JSON matching: ${JSON.stringify(HYPOTHESIS_SCHEMA)}`,
          },
        ],
      }),
    });
    const body = await response.json() as any;
    if (!response.ok) throw providerError("Kimi", response.status, body);
    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new Error("Kimi returned no final JSON content");
    return parseHypothesis(text, {
      provider: this.provider,
      model: this.model,
      responseId: stringOrUndefined(body?.id ?? body?.request_id),
      latencyMs: Date.now() - startedAt,
      promptVersion: this.promptVersion,
    });
  }
}

export function parseHypothesis(text: string, provenance: ResearchAgentProvenance): ResearchHypothesis {
  let raw: RawHypothesis;
  try {
    raw = JSON.parse(text) as RawHypothesis;
  } catch (error) {
    throw new Error(`Research agent returned invalid JSON: ${String(error)}`);
  }

  const strategyResult = validateStrategy(raw.strategy);
  if (!strategyResult.valid || !strategyResult.strategy) {
    throw new Error(`Research agent strategy failed local DSL validation: ${strategyResult.errors.join("; ")}`);
  }
  if (typeof raw.confidence !== "number" || !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1) {
    throw new Error("Research agent confidence must be a finite number in [0, 1]");
  }
  if (typeof raw.reasoning !== "string" || !raw.reasoning.trim()) {
    throw new Error("Research agent reasoning must be a non-empty string");
  }

  return {
    strategy: strategyResult.strategy,
    confidence: raw.confidence,
    reasoning: raw.reasoning.trim(),
    provenance,
  };
}

export function buildResearchInput(event: CandidateEvent, context: ResearchContext): string {
  return JSON.stringify({
    objective: "Propose one falsifiable strategy hypothesis in the supported Strategy DSL.",
    candidateEvent: event,
    marketContext: {
      targetMarket: context.targetMarket ?? null,
      recentCandles: context.recentCandles,
      regime: context.regime ?? null,
      relatedEvents: context.relatedEvents ?? [],
      constraints: context.researchConstraints ?? [],
    },
  });
}

function extractOpenAIOutputText(body: any): string {
  if (typeof body?.output_text === "string" && body.output_text.trim()) return body.output_text;
  const chunks: string[] = [];
  for (const item of Array.isArray(body?.output) ? body.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (content?.type === "output_text" && typeof content?.text === "string") chunks.push(content.text);
    }
  }
  const text = chunks.join("").trim();
  if (!text) throw new Error("OpenAI returned no final output_text content");
  return text;
}

function providerError(provider: string, status: number, body: any): Error {
  const message = body?.error?.message ?? body?.message ?? `HTTP ${status}`;
  return new Error(`${provider} research request failed (${status}): ${String(message)}`);
}

function requiredSecret(value: string, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
