import type { TradingMode } from "@quant-swarm/shared";

export interface RiskLimits {
  maxPortfolioExposurePct: number;
  maxSymbolExposurePct: number;
  maxDailyLossPct: number;
  maxDrawdownPct: number;
  maxLeverage: number;
}

export interface PortfolioState {
  equity: number;
  peakEquity: number;
  dailyPnl: number;
  dailyPnlPct: number;
  drawdownPct: number;
  totalExposurePct: number;
  symbolExposures: Map<string, number>;
}

export interface ProposedOrder {
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  leverage: number;
  strategyId: string;
  /**
   * A reduce-only order may decrease existing exposure but can never increase it.
   * Direction alone (BUY/SELL) is deliberately not used to infer this intent.
   */
  reduceOnly?: boolean;
}

export type RiskDecision =
  | { approved: true; projectedPortfolioExposurePct: number; projectedSymbolExposurePct: number }
  | { approved: false; reason: RiskRejectionReason };

export type RiskRejectionReason =
  | "DAILY_LOSS_LIMIT"
  | "MAX_DRAWDOWN"
  | "MAX_LEVERAGE"
  | "MAX_PORTFOLIO_EXPOSURE"
  | "MAX_SYMBOL_EXPOSURE"
  | "KILL_SWITCH_ACTIVE"
  | "LIVE_TRADING_DISABLED"
  | "INVALID_ORDER";

/**
 * Persistence boundary for the sovereign kill switch.
 * Production implementations can use Redis/Postgres/a dedicated risk daemon.
 * No deactivate method exists by design.
 */
export interface KillSwitchStore {
  isActive(): boolean;
  activate(): void;
}

export class InMemoryKillSwitchStore implements KillSwitchStore {
  private active = false;

  isActive(): boolean {
    return this.active;
  }

  activate(): void {
    this.active = true;
  }
}

export class RiskEngine {
  private readonly limits: Readonly<RiskLimits>;
  private readonly mode: TradingMode;
  private readonly liveTradingEnabled: boolean;
  private readonly killSwitchStore: KillSwitchStore;

  constructor(
    limits: RiskLimits,
    mode: TradingMode = "shadow",
    liveTradingEnabled = false,
    killSwitchStore: KillSwitchStore = new InMemoryKillSwitchStore()
  ) {
    this.limits = Object.freeze({ ...limits });
    this.mode = mode;
    this.liveTradingEnabled = liveTradingEnabled;
    this.killSwitchStore = killSwitchStore;
  }

  evaluateOrder(order: ProposedOrder, state: PortfolioState): RiskDecision {
    if (this.killSwitchStore.isActive()) {
      return { approved: false, reason: "KILL_SWITCH_ACTIVE" };
    }

    if (this.mode === "live" && !this.liveTradingEnabled) {
      return { approved: false, reason: "LIVE_TRADING_DISABLED" };
    }

    if (
      !Number.isFinite(state.equity) ||
      state.equity <= 0 ||
      !Number.isFinite(order.quantity) ||
      !Number.isFinite(order.price) ||
      !Number.isFinite(order.leverage) ||
      order.quantity <= 0 ||
      order.price <= 0 ||
      order.leverage < 0
    ) {
      return { approved: false, reason: "INVALID_ORDER" };
    }

    if (state.dailyPnlPct <= -this.limits.maxDailyLossPct) {
      return { approved: false, reason: "DAILY_LOSS_LIMIT" };
    }

    if (state.drawdownPct >= this.limits.maxDrawdownPct) {
      this.killSwitchStore.activate();
      return { approved: false, reason: "MAX_DRAWDOWN" };
    }

    if (order.leverage > this.limits.maxLeverage) {
      return { approved: false, reason: "MAX_LEVERAGE" };
    }

    const orderExposurePct = ((order.quantity * order.price) / state.equity) * 100;
    const currentSymbolExposure = state.symbolExposures.get(order.symbol) ?? 0;

    let projectedPortfolioExposurePct: number;
    let projectedSymbolExposurePct: number;

    if (order.reduceOnly) {
      projectedPortfolioExposurePct = Math.max(
        0,
        state.totalExposurePct - Math.min(orderExposurePct, currentSymbolExposure)
      );
      projectedSymbolExposurePct = Math.max(0, currentSymbolExposure - orderExposurePct);
    } else {
      projectedPortfolioExposurePct = state.totalExposurePct + orderExposurePct;
      projectedSymbolExposurePct = currentSymbolExposure + orderExposurePct;
    }

    if (projectedPortfolioExposurePct > this.limits.maxPortfolioExposurePct) {
      return { approved: false, reason: "MAX_PORTFOLIO_EXPOSURE" };
    }

    if (projectedSymbolExposurePct > this.limits.maxSymbolExposurePct) {
      return { approved: false, reason: "MAX_SYMBOL_EXPOSURE" };
    }

    return {
      approved: true,
      projectedPortfolioExposurePct,
      projectedSymbolExposurePct,
    };
  }

  activateKillSwitch(): void {
    this.killSwitchStore.activate();
  }

  isKillSwitchActive(): boolean {
    return this.killSwitchStore.isActive();
  }

  getMode(): TradingMode {
    return this.mode;
  }

  getLimits(): Readonly<RiskLimits> {
    return this.limits;
  }
}

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxPortfolioExposurePct: 50,
  maxSymbolExposurePct: 10,
  maxDailyLossPct: 3,
  maxDrawdownPct: 15,
  maxLeverage: 3,
};
