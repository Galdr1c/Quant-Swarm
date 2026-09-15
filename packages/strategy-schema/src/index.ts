import { z } from "zod";

// ─── Supported Indicator Types ────────────────────────────────────────────────

export const INDICATOR_TYPES = [
  "EMA",
  "SMA",
  "RSI",
  "ATR",
  "MACD",
  "SUPERTREND",
  "BBANDS",
  "VWAP",
] as const;

export type IndicatorType = (typeof INDICATOR_TYPES)[number];

// ─── Supported Rule Operators ─────────────────────────────────────────────────

export const RULE_OPERATORS = [
  ">",
  "<",
  ">=",
  "<=",
  "crosses_above",
  "crosses_below",
] as const;

export type RuleOperator = (typeof RULE_OPERATORS)[number];

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

export const IndicatorDefinitionSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.enum(INDICATOR_TYPES),
  params: z.record(z.union([z.number(), z.string(), z.boolean()])),
});

export const RuleSchema = z.object({
  left: z.string().min(1),
  operator: z.enum(RULE_OPERATORS),
  right: z.union([z.string(), z.number()]),
});

export const RuleGroupSchema: z.ZodType<RuleGroup> = z.object({
  operator: z.enum(["AND", "OR"]),
  rules: z.array(RuleSchema).min(1),
});

export const StrategyDefinitionSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(256),

  market: z.object({
    symbol: z.string().min(1),
    timeframe: z.string().min(1),
  }),

  indicators: z.array(IndicatorDefinitionSchema).min(1).max(20),

  entry: RuleGroupSchema,
  exit: RuleGroupSchema,

  risk: z.object({
    stopLossPct: z.number().positive().max(50).optional(),
    takeProfitPct: z.number().positive().max(100).optional(),
    maxPositionPct: z.number().positive().max(100),
  }),
});

// ─── TypeScript Interfaces (derived from Zod) ────────────────────────────────

export type IndicatorDefinition = z.infer<typeof IndicatorDefinitionSchema>;
export type Rule = z.infer<typeof RuleSchema>;
export type StrategyDefinition = z.infer<typeof StrategyDefinitionSchema>;

export interface RuleGroup {
  operator: "AND" | "OR";
  rules: Rule[];
}

// ─── Validation ───────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  strategy?: StrategyDefinition;
  errors: string[];
}

/**
 * Validate a raw JSON object (e.g. AI output) against the Strategy DSL.
 * Performs both structural (Zod) and semantic validation.
 */
export function validateStrategy(input: unknown): ValidationResult {
  // Structural validation
  const parsed = StrategyDefinitionSchema.safeParse(input);

  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`
      ),
    };
  }

  const strategy = parsed.data;
  const semanticErrors: string[] = [];

  // Semantic: all rule references must point to defined indicators or numeric values
  const indicatorIds = new Set(strategy.indicators.map((ind) => ind.id));

  const checkRuleRefs = (group: RuleGroup, context: string) => {
    for (const rule of group.rules) {
      if (!indicatorIds.has(rule.left)) {
        semanticErrors.push(
          `${context}: rule references undefined indicator "${rule.left}"`
        );
      }
      if (typeof rule.right === "string" && !indicatorIds.has(rule.right)) {
        semanticErrors.push(
          `${context}: rule references undefined indicator "${rule.right}"`
        );
      }
    }
  };

  checkRuleRefs(strategy.entry, "entry");
  checkRuleRefs(strategy.exit, "exit");

  // Semantic: stopLoss < takeProfit if both defined
  if (
    strategy.risk.stopLossPct !== undefined &&
    strategy.risk.takeProfitPct !== undefined &&
    strategy.risk.stopLossPct >= strategy.risk.takeProfitPct
  ) {
    semanticErrors.push(
      `risk: stopLossPct (${strategy.risk.stopLossPct}) should be less than takeProfitPct (${strategy.risk.takeProfitPct})`
    );
  }

  // Semantic: indicator params should have at least "length" or type-specific params
  for (const ind of strategy.indicators) {
    if (ind.type === "MACD") {
      // MACD needs fastLength, slowLength, signalLength
      if (!("fastLength" in ind.params) && !("length" in ind.params)) {
        semanticErrors.push(
          `indicator "${ind.id}": MACD should have fastLength/slowLength/signalLength or length`
        );
      }
    } else if (ind.type === "SUPERTREND") {
      if (!("factor" in ind.params) && !("atrLength" in ind.params)) {
        semanticErrors.push(
          `indicator "${ind.id}": SUPERTREND should have factor and atrLength`
        );
      }
    }
  }

  if (semanticErrors.length > 0) {
    return {
      valid: false,
      strategy,
      errors: semanticErrors,
    };
  }

  return {
    valid: true,
    strategy,
    errors: [],
  };
}
