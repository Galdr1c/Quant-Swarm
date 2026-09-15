import type { TradingMode } from "@quant-swarm/shared";

// ─── Risk Limits ──────────────────────────────────────────────────────────────

export interface RiskLimits {
  /** Maximum total portfolio exposure as % of equity */
  maxPortfolioExposurePct: number;
  /** Maximum single-symbol exposure as % of equity */
  maxSymbolExposurePct: number;
  /** Maximum daily loss as % of equity — triggers daily halt */
  maxDailyLossPct: number;
  /** Maximum drawdown from peak — triggers kill switch */
  maxDrawdownPct: number;
  /** Maximum leverage allowed */
  maxLeverage: number;
}

// ─── Portfolio State ──────────────────────────────────────────────────────────

export interface PortfolioState {
  equity: number;
  peakEquity: number;
  dailyPnl: number;
  dailyPnlPct: number;
  drawdownPct: number;
  totalExposurePct: number;
  symbolExposures: Map<string, number>;
}

// ─── Proposed Order ───────────────────────────────────────────────────────────

export interface ProposedOrder {
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  leverage: number;
  strategyId: string;
}

// ─── Risk Decision ────────────────────────────────────────────────────────────

export type RiskDecision =
  | { approved: true }
  | { approved: false; reason: RiskRejectionReason };

export type RiskRejectionReason =
  | "DAILY_LOSS_LIMIT"
  | "MAX_DRAWDOWN"
  | "MAX_LEVERAGE"
  | "MAX_PORTFOLIO_EXPOSURE"
  | "MAX_SYMBOL_EXPOSURE"
  | "KILL_SWITCH_ACTIVE"
  | "LIVE_TRADING_DISABLED";

// ─── Risk Engine ──────────────────────────────────────────────────────────────

/**
 * Independent Risk Engine.
 *
 * No AI can override these limits. The kill switch cannot be
 * programmatically deactivated — it requires a manual restart.
 */
export class RiskEngine {
  private limits: RiskLimits;
  private mode: TradingMode;
  private killSwitchActive = false;
  private liveTradingEnabled: boolean;

  constructor(
    limits: RiskLimits,
    mode: TradingMode = "shadow",
    liveTradingEnabled = false
  ) {
    this.limits = Object.freeze({ ...limits });
    this.mode = mode;
    this.liveTradingEnabled = liveTradingEnabled;
  }

  /**
   * Evaluate a proposed order against risk limits.
   * Returns approved: true only if ALL checks pass.
   */
  evaluateOrder(
    order: ProposedOrder,
    state: PortfolioState
  ): RiskDecision {
    // Kill switch — once active, nothing passes
    if (this.killSwitchActive) {
      return { approved: false, reason: "KILL_SWITCH_ACTIVE" };
    }

    // Live trading guard
    if (this.mode === "live" && !this.liveTradingEnabled) {
      return { approved: false, reason: "LIVE_TRADING_DISABLED" };
    }

    // Daily loss limit
    if (Math.abs(state.dailyPnlPct) >= this.limits.maxDailyLossPct && state.dailyPnlPct < 0) {
      return { approved: false, reason: "DAILY_LOSS_LIMIT" };
    }

    // Max drawdown — also triggers kill switch
    if (state.drawdownPct >= this.limits.maxDrawdownPct) {
      this.killSwitchActive = true;
      return { approved: false, reason: "MAX_DRAWDOWN" };
    }

    // Leverage check
    if (order.leverage > this.limits.maxLeverage) {
      return { approved: false, reason: "MAX_LEVERAGE" };
    }

    // Portfolio exposure
    const orderExposurePct =
      ((order.quantity * order.price) / state.equity) * 100;
    if (
      state.totalExposurePct + orderExposurePct >
      this.limits.maxPortfolioExposurePct
    ) {
      return { approved: false, reason: "MAX_PORTFOLIO_EXPOSURE" };
    }

    // Symbol exposure
    const currentSymbolExposure =
      state.symbolExposures.get(order.symbol) ?? 0;
    if (
      currentSymbolExposure + orderExposurePct >
      this.limits.maxSymbolExposurePct
    ) {
      return { approved: false, reason: "MAX_SYMBOL_EXPOSURE" };
    }

    return { approved: true };
  }

  /** Activate the kill switch. Cannot be deactivated programmatically. */
  activateKillSwitch(): void {
    this.killSwitchActive = true;
  }

  isKillSwitchActive(): boolean {
    return this.killSwitchActive;
  }

  getMode(): TradingMode {
    return this.mode;
  }

  getLimits(): Readonly<RiskLimits> {
    return this.limits;
  }
}

// ─── Default Risk Limits ──────────────────────────────────────────────────────

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxPortfolioExposurePct: 50,
  maxSymbolExposurePct: 10,
  maxDailyLossPct: 3,
  maxDrawdownPct: 15,
  maxLeverage: 3,
};
