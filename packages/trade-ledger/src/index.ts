import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  PortfolioState,
  ProposedOrder,
  RiskDecision,
  RiskEngine,
} from "@quant-swarm/risk-contracts";
import type { TradingMode } from "@quant-swarm/shared";

export type TradeSide = "BUY" | "SELL";
export type ExecutedTradingMode = Extract<TradingMode, "paper" | "live">;

export interface TradeFill {
  schemaVersion: 1;
  id: string;
  symbol: string;
  mode: ExecutedTradingMode;
  side: TradeSide;
  timestamp: number;
  price: number;
  quantity: number;
  notional: number;
  fee: number;
  strategyId: string;
  source: "paper-executor" | "broker";
  externalId?: string;
}

export interface TradeLedger {
  append(fill: TradeFill): Promise<"inserted" | "duplicate">;
  list(symbol?: string): Promise<TradeFill[]>;
}

export interface PaperPositionSnapshot {
  symbol: string;
  quantity: number;
  averageEntryPrice: number;
  marketPrice: number;
  marketValue: number;
  unrealizedPnl: number;
  realizedPnl: number;
}

export interface PaperPortfolioSnapshot {
  initialCash: number;
  cash: number;
  equity: number;
  peakEquity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalFees: number;
  grossExposure: number;
  drawdownPct: number;
  positions: PaperPositionSnapshot[];
}

interface PaperPositionState {
  quantity: number;
  averageEntryPrice: number;
  realizedPnl: number;
}

export class PaperPortfolio {
  private readonly positions = new Map<string, PaperPositionState>();
  private cashValue: number;
  private peakEquityValue: number;
  private totalFeesValue = 0;

  constructor(readonly initialCash: number) {
    if (!Number.isFinite(initialCash) || initialCash <= 0) {
      throw new Error("PaperPortfolio initialCash must be positive");
    }
    this.cashValue = initialCash;
    this.peakEquityValue = initialCash;
  }

  get cash(): number {
    return this.cashValue;
  }

  applyFill(fill: TradeFill): void {
    validateTradeFill(fill);
    if (fill.mode !== "paper") {
      throw new Error("PaperPortfolio accepts paper fills only");
    }

    const current = this.positions.get(fill.symbol) ?? {
      quantity: 0,
      averageEntryPrice: 0,
      realizedPnl: 0,
    };

    if (fill.side === "BUY") {
      const requiredCash = fill.notional + fill.fee;
      if (requiredCash > this.cashValue + 1e-9) {
        throw new Error(
          `Insufficient paper cash for ${fill.symbol}: required ${requiredCash.toFixed(8)}, available ${this.cashValue.toFixed(8)}`
        );
      }
      const nextQuantity = current.quantity + fill.quantity;
      const weightedCost =
        current.averageEntryPrice * current.quantity + fill.price * fill.quantity;
      this.cashValue -= requiredCash;
      this.totalFeesValue += fill.fee;
      this.positions.set(fill.symbol, {
        quantity: nextQuantity,
        averageEntryPrice: weightedCost / nextQuantity,
        realizedPnl: current.realizedPnl,
      });
      return;
    }

    if (fill.quantity > current.quantity + 1e-12) {
      throw new Error(
        `PaperPortfolio cannot sell more ${fill.symbol} than the long position`
      );
    }
    const realized = (fill.price - current.averageEntryPrice) * fill.quantity;
    const nextQuantity = Math.max(0, current.quantity - fill.quantity);
    this.cashValue += fill.notional - fill.fee;
    this.totalFeesValue += fill.fee;

    if (nextQuantity <= 1e-12) {
      this.positions.delete(fill.symbol);
    } else {
      this.positions.set(fill.symbol, {
        quantity: nextQuantity,
        averageEntryPrice: current.averageEntryPrice,
        realizedPnl: current.realizedPnl + realized,
      });
    }

    if (nextQuantity <= 1e-12 && current.quantity > 0) {
      // Keep realized history on the closed symbol only in aggregate via snapshot
      // reconstruction; open-position state intentionally contains no zero-qty rows.
    }
    this.closedRealizedPnl += realized;
  }

  private closedRealizedPnl = 0;

  snapshot(marks: Readonly<Record<string, number>> = {}): PaperPortfolioSnapshot {
    const positions: PaperPositionSnapshot[] = [];
    let grossExposure = 0;
    let unrealizedPnl = 0;
    let openRealizedPnl = 0;

    for (const [symbol, position] of [...this.positions.entries()].sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
      const rawMark = marks[symbol];
      const marketPrice =
        Number.isFinite(rawMark) && rawMark > 0
          ? rawMark
          : position.averageEntryPrice;
      const marketValue = position.quantity * marketPrice;
      const unrealized = (marketPrice - position.averageEntryPrice) * position.quantity;
      grossExposure += Math.abs(marketValue);
      unrealizedPnl += unrealized;
      openRealizedPnl += position.realizedPnl;
      positions.push({
        symbol,
        quantity: position.quantity,
        averageEntryPrice: position.averageEntryPrice,
        marketPrice,
        marketValue,
        unrealizedPnl: unrealized,
        realizedPnl: position.realizedPnl,
      });
    }

    const equity = this.cashValue + positions.reduce(
      (sum, position) => sum + position.marketValue,
      0
    );
    this.peakEquityValue = Math.max(this.peakEquityValue, equity);
    const drawdownPct = this.peakEquityValue > 0
      ? ((this.peakEquityValue - equity) / this.peakEquityValue) * 100
      : 0;

    return {
      initialCash: this.initialCash,
      cash: this.cashValue,
      equity,
      peakEquity: this.peakEquityValue,
      realizedPnl: this.closedRealizedPnl + openRealizedPnl,
      unrealizedPnl,
      totalFees: this.totalFeesValue,
      grossExposure,
      drawdownPct,
      positions,
    };
  }

  toRiskState(
    marks: Readonly<Record<string, number>> = {},
    dayStartEquity?: number
  ): PortfolioState {
    const snapshot = this.snapshot(marks);
    const baseline =
      dayStartEquity !== undefined && Number.isFinite(dayStartEquity) && dayStartEquity > 0
        ? dayStartEquity
        : this.initialCash;
    const dailyPnl = snapshot.equity - baseline;
    const symbolExposures = new Map<string, number>();
    for (const position of snapshot.positions) {
      symbolExposures.set(
        position.symbol,
        snapshot.equity > 0 ? (Math.abs(position.marketValue) / snapshot.equity) * 100 : 0
      );
    }

    return {
      equity: snapshot.equity,
      peakEquity: snapshot.peakEquity,
      dailyPnl,
      dailyPnlPct: (dailyPnl / baseline) * 100,
      drawdownPct: snapshot.drawdownPct,
      totalExposurePct:
        snapshot.equity > 0 ? (snapshot.grossExposure / snapshot.equity) * 100 : 0,
      symbolExposures,
    };
  }
}

export async function rebuildPaperPortfolio(
  ledger: TradeLedger,
  initialCash: number
): Promise<PaperPortfolio> {
  const portfolio = new PaperPortfolio(initialCash);
  for (const fill of await ledger.list()) {
    if (fill.mode === "paper") portfolio.applyFill(fill);
  }
  return portfolio;
}

export class JsonlTradeLedger implements TradeLedger {
  constructor(private readonly filePath: string) {
    if (!filePath.trim()) throw new Error("Trade ledger path cannot be empty");
  }

  async append(fill: TradeFill): Promise<"inserted" | "duplicate"> {
    validateTradeFill(fill);
    const existing = (await this.list()).find((row) => row.id === fill.id);
    if (existing) {
      if (canonicalTrade(existing) === canonicalTrade(fill)) return "duplicate";
      throw new Error(`Conflicting trade fill id already exists: ${fill.id}`);
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, JSON.stringify(fill) + "\n", "utf8");
    return "inserted";
  }

  async list(symbol?: string): Promise<TradeFill[]> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error: any) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }

    const rows: TradeFill[] = [];
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        throw new Error(`Invalid trade-ledger JSON on line ${index + 1}: ${String(error)}`);
      }
      validateTradeFill(parsed);
      const fill = parsed as TradeFill;
      if (!symbol || fill.symbol === symbol) rows.push(fill);
    }
    return rows.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
  }
}

export interface PaperExecutorOptions {
  slippageBps?: number;
  feeBps?: number;
  now?: () => number;
  idFactory?: () => string;
}

export interface PaperExecutionResult {
  risk: RiskDecision;
  fill?: TradeFill;
  portfolio?: PaperPortfolioSnapshot;
}

export class PaperExecutor {
  private readonly slippageBps: number;
  private readonly feeBps: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;

  constructor(
    private readonly ledger: TradeLedger,
    options: PaperExecutorOptions = {}
  ) {
    this.slippageBps = nonNegativeFinite(options.slippageBps, 2, "slippageBps");
    this.feeBps = nonNegativeFinite(options.feeBps, 5, "feeBps");
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async execute(
    order: ProposedOrder,
    state: PortfolioState,
    riskEngine: RiskEngine
  ): Promise<PaperExecutionResult> {
    if (riskEngine.getMode() !== "paper") {
      throw new Error("PaperExecutor requires RiskEngine mode=paper");
    }

    const risk = riskEngine.evaluateOrder(order, state);
    if (!risk.approved) return { risk };

    const fill = this.buildFill(order);
    await this.ledger.append(fill);
    return { risk, fill };
  }

  async executeAgainstPortfolio(
    order: ProposedOrder,
    portfolio: PaperPortfolio,
    riskEngine: RiskEngine,
    marks: Readonly<Record<string, number>> = {},
    dayStartEquity?: number
  ): Promise<PaperExecutionResult> {
    if (riskEngine.getMode() !== "paper") {
      throw new Error("PaperExecutor requires RiskEngine mode=paper");
    }

    const state = portfolio.toRiskState(marks, dayStartEquity);
    const risk = riskEngine.evaluateOrder(order, state);
    if (!risk.approved) return { risk, portfolio: portfolio.snapshot(marks) };

    const fill = this.buildFill(order);

    // Validate cash/position constraints before persistence so the append-only
    // ledger never contains a fill the paper account could not actually settle.
    await rebuildPortfolioWithPendingFill(portfolio, fill, marks);
    await this.ledger.append(fill);
    portfolio.applyFill(fill);
    return { risk, fill, portfolio: portfolio.snapshot(marks) };
  }

  private buildFill(order: ProposedOrder): TradeFill {
    const slip = this.slippageBps / 10_000;
    const price = order.side === "BUY"
      ? order.price * (1 + slip)
      : order.price * (1 - slip);
    const notional = price * order.quantity;
    const fee = notional * (this.feeBps / 10_000);
    return {
      schemaVersion: 1,
      id: this.idFactory(),
      symbol: order.symbol,
      mode: "paper",
      side: order.side,
      timestamp: this.now(),
      price,
      quantity: order.quantity,
      notional,
      fee,
      strategyId: order.strategyId,
      source: "paper-executor",
    };
  }
}

async function rebuildPortfolioWithPendingFill(
  portfolio: PaperPortfolio,
  fill: TradeFill,
  marks: Readonly<Record<string, number>>
): Promise<PaperPortfolioSnapshot> {
  const snapshot = portfolio.snapshot(marks);
  const clone = new PaperPortfolio(snapshot.initialCash);
  // Reconstruct open positions using synthetic paper fills at average cost.
  // This clone is validation-only and is never persisted.
  for (const position of snapshot.positions) {
    clone.applyFill({
      schemaVersion: 1,
      id: `probe-open-${position.symbol}`,
      symbol: position.symbol,
      mode: "paper",
      side: "BUY",
      timestamp: 1,
      price: position.averageEntryPrice,
      quantity: position.quantity,
      notional: position.averageEntryPrice * position.quantity,
      fee: 0,
      strategyId: "portfolio-probe",
      source: "paper-executor",
    });
  }
  // Adjusting clone cash to exact live state through public APIs would distort
  // settlement validation, so validate the two constraints directly below.
  if (fill.side === "BUY" && fill.notional + fill.fee > snapshot.cash + 1e-9) {
    throw new Error("Insufficient paper cash for order settlement");
  }
  const open = snapshot.positions.find((position) => position.symbol === fill.symbol);
  if (fill.side === "SELL" && fill.quantity > (open?.quantity ?? 0) + 1e-12) {
    throw new Error(`PaperPortfolio cannot sell more ${fill.symbol} than the long position`);
  }
  return snapshot;
}

export function brokerFill(input: Omit<TradeFill, "schemaVersion" | "mode" | "source">): TradeFill {
  const fill: TradeFill = {
    schemaVersion: 1,
    ...input,
    mode: "live",
    source: "broker",
  };
  validateTradeFill(fill);
  return fill;
}

export function validateTradeFill(value: unknown): asserts value is TradeFill {
  if (!value || typeof value !== "object") throw new Error("Trade fill must be an object");
  const fill = value as Partial<TradeFill>;
  if (fill.schemaVersion !== 1) throw new Error("Unsupported trade fill schemaVersion");
  if (typeof fill.id !== "string" || !fill.id.trim()) throw new Error("Trade fill id is required");
  if (typeof fill.symbol !== "string" || !fill.symbol.includes(":")) {
    throw new Error("Trade fill symbol must be exchange-qualified");
  }
  if (fill.mode !== "paper" && fill.mode !== "live") throw new Error("Trade fill mode is invalid");
  if (fill.side !== "BUY" && fill.side !== "SELL") throw new Error("Trade fill side is invalid");
  if (fill.source !== "paper-executor" && fill.source !== "broker") {
    throw new Error("Trade fill source is invalid");
  }
  if (!Number.isSafeInteger(fill.timestamp) || Number(fill.timestamp) <= 0) {
    throw new Error("Trade fill timestamp must be a positive integer");
  }
  for (const [name, number] of [
    ["price", fill.price],
    ["quantity", fill.quantity],
    ["notional", fill.notional],
  ] as const) {
    if (!Number.isFinite(number) || Number(number) <= 0) {
      throw new Error(`Trade fill ${name} must be positive`);
    }
  }
  if (!Number.isFinite(fill.fee) || Number(fill.fee) < 0) {
    throw new Error("Trade fill fee must be non-negative");
  }
  if (typeof fill.strategyId !== "string" || !fill.strategyId.trim()) {
    throw new Error("Trade fill strategyId is required");
  }
}

function canonicalTrade(fill: TradeFill): string {
  return JSON.stringify(fill, Object.keys(fill).sort());
}

function nonNegativeFinite(
  value: number | undefined,
  fallback: number,
  name: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
  return resolved;
}
