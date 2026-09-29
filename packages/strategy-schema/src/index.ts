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

  // Semantic: indicator ids must be unique; otherwise the quant runner would overwrite
  // one computed series with another under the same key.
  const indicatorIds = new Set<string>();
  for (const ind of strategy.indicators) {
    if (indicatorIds.has(ind.id)) {
      semanticErrors.push(`indicator id "${ind.id}" is duplicated`);
    }
    indicatorIds.add(ind.id);
  }

  // Semantic: all rule references must point to defined indicators or numeric values

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

  // Semantic: reject parameters that would make the deterministic indicator
  // implementation undefined or misleading. Missing params may still use the
  // quant engine's documented defaults.
  for (const ind of strategy.indicators) {
    const numeric = (name: string): number | undefined => {
      const value = ind.params[name];
      return typeof value === "number" ? value : undefined;
    };
    const integerAtLeast = (name: string, minimum: number) => {
      const value = numeric(name);
      if (value !== undefined && (!Number.isInteger(value) || value < minimum)) {
        semanticErrors.push(
          `indicator "${ind.id}": ${name} must be an integer >= ${minimum}`
        );
      }
    };
    const positive = (name: string) => {
      const value = numeric(name);
      if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
        semanticErrors.push(
          `indicator "${ind.id}": ${name} must be > 0`
        );
      }
    };

    if (ind.type === "EMA" || ind.type === "SMA" || ind.type === "RSI" || ind.type === "ATR") {
      integerAtLeast("length", 2);
    } else if (ind.type === "MACD") {
      integerAtLeast("length", 2);
      integerAtLeast("fastLength", 2);
      integerAtLeast("slowLength", 2);
      integerAtLeast("signalLength", 2);
      const fast = numeric("fastLength") ?? numeric("length") ?? 12;
      const slow = numeric("slowLength") ?? 26;
      if (Number.isFinite(fast) && Number.isFinite(slow) && fast >= slow) {
        semanticErrors.push(
          `indicator "${ind.id}": MACD fastLength must be less than slowLength`
        );
      }
    } else if (ind.type === "SUPERTREND") {
      positive("factor");
      integerAtLeast("atrLength", 2);
    } else if (ind.type === "BBANDS") {
      integerAtLeast("length", 2);
      positive("stddev");
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
