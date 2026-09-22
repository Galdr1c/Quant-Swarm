import type { ValidationCheck, ValidationVerdict } from "@quant-swarm/shared";

export type UniverseResultStatus = "COMPLETED" | "NO_SIGNAL" | "ERROR";

export interface UniverseBacktestSnapshot {
  netReturn: number;
  annualReturn: number;
  sharpe: number;
  sortino: number;
  maxDrawdown: number;
  profitFactor: number;
  expectancy: number;
  totalTrades: number;
  winRate: number;
}

export interface UniverseResearchResult {
  symbol: string;
  timeframe: string;
  status: UniverseResultStatus;
  runId?: string;
  candidate?: { type: string; score: number; timestamp: number };
  selectedStrategy?: { id: string; name: string };
  validation?: UniverseBacktestSnapshot;
  finalHoldout?: UniverseBacktestSnapshot;
  verdict?: ValidationVerdict;
  checks?: ValidationCheck[];
  equityCurve?: number[];
  error?: string;
}

export interface UniverseSummary {
  assets: number;
  completed: number;
  pass: number;
  review: number;
  fail: number;
  noSignal: number;
  errors: number;
  positiveHoldout: number;
  positiveHoldoutRate: number;
  averageHoldoutReturn: number;
  medianHoldoutSharpe: number;
}

export interface UniverseResearchReport {
  schemaVersion: 1;
  generatedAt: string;
  source: "tradingview";
  demo?: boolean;
  summary: UniverseSummary;
  results: UniverseResearchResult[];
}

const VERDICT_ORDER: Record<ValidationVerdict, number> = {
  PASS: 0,
  REVIEW: 1,
  FAIL: 2,
};

export function rankUniverseResults(
  results: readonly UniverseResearchResult[]
): UniverseResearchResult[] {
  return [...results].sort((a, b) => {
    if (a.status !== b.status) {
      if (a.status === "COMPLETED") return -1;
      if (b.status === "COMPLETED") return 1;
      if (a.status === "NO_SIGNAL") return -1;
      if (b.status === "NO_SIGNAL") return 1;
    }

    const av = a.verdict ? VERDICT_ORDER[a.verdict] : 99;
    const bv = b.verdict ? VERDICT_ORDER[b.verdict] : 99;
    if (av !== bv) return av - bv;

    const as = a.finalHoldout?.sharpe ?? Number.NEGATIVE_INFINITY;
    const bs = b.finalHoldout?.sharpe ?? Number.NEGATIVE_INFINITY;
    if (as !== bs) return bs - as;

    const ar = a.finalHoldout?.netReturn ?? Number.NEGATIVE_INFINITY;
    const br = b.finalHoldout?.netReturn ?? Number.NEGATIVE_INFINITY;
    if (ar !== br) return br - ar;

    return (a.symbol + ":" + a.timeframe).localeCompare(b.symbol + ":" + b.timeframe);
  });
}

export function summarizeUniverseResults(
  results: readonly UniverseResearchResult[]
): UniverseSummary {
  const completed = results.filter((row) => row.status === "COMPLETED");
  const holdoutReturns = completed
    .map((row) => row.finalHoldout?.netReturn)
    .filter((value): value is number => value !== undefined && Number.isFinite(value));
  const sharpes = completed
    .map((row) => row.finalHoldout?.sharpe)
    .filter((value): value is number => value !== undefined && Number.isFinite(value))
    .sort((a, b) => a - b);
  const positiveHoldout = holdoutReturns.filter((value) => value > 0).length;

  return {
    assets: results.length,
    completed: completed.length,
    pass: completed.filter((row) => row.verdict === "PASS").length,
    review: completed.filter((row) => row.verdict === "REVIEW").length,
    fail: completed.filter((row) => row.verdict === "FAIL").length,
    noSignal: results.filter((row) => row.status === "NO_SIGNAL").length,
    errors: results.filter((row) => row.status === "ERROR").length,
    positiveHoldout,
    positiveHoldoutRate: completed.length === 0 ? 0 : (positiveHoldout / completed.length) * 100,
    averageHoldoutReturn: average(holdoutReturns),
    medianHoldoutSharpe: median(sharpes),
  };
}

export function buildUniverseReport(
  results: readonly UniverseResearchResult[],
  generatedAt = new Date().toISOString()
): UniverseResearchReport {
  const ranked = rankUniverseResults(results);
  return {
    schemaVersion: 1,
    generatedAt,
    source: "tradingview",
    summary: summarizeUniverseResults(ranked),
    results: ranked,
  };
}

export function downsampleSeries(values: readonly number[], maxPoints = 80): number[] {
  if (maxPoints < 2) throw new Error("maxPoints must be at least 2");
  if (values.length <= maxPoints) return [...values];
  const output: number[] = [];
  for (let i = 0; i < maxPoints; i += 1) {
    const index = Math.round((i / (maxPoints - 1)) * (values.length - 1));
    output.push(values[index]);
  }
  return output;
}

export function annualizationForTimeframe(timeframe: string): number {
  const value = timeframe.trim();
  const minuteMatch = value.match(/^(\d+)m$/i);
  if (minuteMatch) return (365.25 * 24 * 60) / Number(minuteMatch[1]);
  const hourMatch = value.match(/^(\d+)h$/i);
  if (hourMatch) return (365.25 * 24) / Number(hourMatch[1]);
  const dayMatch = value.match(/^(\d+)d$/i);
  if (dayMatch) return 365.25 / Number(dayMatch[1]);
  const weekMatch = value.match(/^(\d+)w$/i);
  if (weekMatch) return 52.1775 / Number(weekMatch[1]);
  if (value === "D") return 365.25;
  if (value === "W") return 52.1775;
  if (value === "M" || /^\d+M$/.test(value)) {
    const months = value === "M" ? 1 : Number(value.slice(0, -1));
    return 12 / months;
  }
  return 365.25;
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const middle = Math.floor(values.length / 2);
  if (values.length % 2 === 1) return values[middle];
  return (values[middle - 1] + values[middle]) / 2;
}
