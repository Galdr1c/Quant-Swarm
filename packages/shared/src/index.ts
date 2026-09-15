// ─── OHLCV ────────────────────────────────────────────────────────────────────

export interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ─── Market Snapshot ──────────────────────────────────────────────────────────

export interface MarketSnapshot {
  symbol: string;
  timeframe: string;
  close: number;
  volume: number;
  atr: number;
  volumeZScore: number;
  returnZScore: number;
  timestamp: number;
}

// ─── Candidate Events ─────────────────────────────────────────────────────────

export type CandidateEventType =
  | "VOLUME_ANOMALY"
  | "VOLATILITY_EXPANSION"
  | "PRICE_DISLOCATION";

export interface CandidateEvent {
  symbol: string;
  type: CandidateEventType;
  score: number;
  timestamp: number;
  metadata: Record<string, number>;
}

// ─── Backtest Results (mirrors Python dataclass) ──────────────────────────────

export interface BacktestResult {
  strategyId: string;
  netReturn: number;
  annualReturn: number;
  sharpe: number;
  sortino: number;
  maxDrawdown: number;
  profitFactor: number;
  expectancy: number;
  totalTrades: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  feesPaid: number;
  slippagePaid: number;
}

// ─── Validation ───────────────────────────────────────────────────────────────

export type ValidationVerdict = "PASS" | "FAIL" | "REVIEW";

export interface ValidationCheck {
  name: string;
  verdict: ValidationVerdict;
  value?: number;
  threshold?: number;
  detail?: string;
}

export interface ValidationReport {
  strategyId: string;
  checks: ValidationCheck[];
  overallVerdict: ValidationVerdict;
}

// ─── Trading Mode ─────────────────────────────────────────────────────────────

export type TradingMode = "shadow" | "paper" | "live";

// ─── Utilities ────────────────────────────────────────────────────────────────

export function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

export function roundTo(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}
