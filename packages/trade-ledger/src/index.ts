import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  KillSwitchStore,
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

export class FileKillSwitchStore implements KillSwitchStore {
  constructor(private readonly filePath: string) {
    if (!filePath.trim()) throw new Error("Kill-switch path cannot be empty");
  }

  isActive(): boolean {
    return existsSync(this.filePath);
  }

  activate(): void {
    if (this.isActive()) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    try {
      writeFileSync(
        this.filePath,
        JSON.stringify({
          schemaVersion: 1,
          active: true,
          activatedAt: Date.now(),
        }) + "\n",
        { encoding: "utf8", flag: "wx" }
      );
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
}

export interface PaperDayState {
  schemaVersion: 1;
  utcDate: string;
  dayStartEquity: number;
  peakEquity: number;
  createdAt: number;
}

export class JsonPaperDayStateStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {
    if (!filePath.trim()) throw new Error("Paper day-state path cannot be empty");
  }

  async getOrCreate(currentEquity: number, now = Date.now()): Promise<PaperDayState> {
    if (!Number.isFinite(currentEquity) || currentEquity <= 0) {
      throw new Error("Paper day-start equity must be positive");
    }
    if (!Number.isSafeInteger(now) || now <= 0) {
      throw new Error("Paper day-state timestamp must be a positive integer");
    }

    return this.serialized(async () => {
      const utcDate = new Date(now).toISOString().slice(0, 10);
      const existing = await this.read();
      if (existing?.utcDate === utcDate) {
        if (currentEquity <= existing.peakEquity) return existing;
        const updated: PaperDayState = {
          ...existing,
          peakEquity: currentEquity,
        };
        await this.write(updated);
        return updated;
      }

      const next: PaperDayState = {
        schemaVersion: 1,
        utcDate,
        dayStartEquity: currentEquity,
        peakEquity: Math.max(existing?.peakEquity ?? currentEquity, currentEquity),
        createdAt: now,
      };
      await this.write(next);
      return next;
    });
  }

  async read(): Promise<PaperDayState | undefined> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error: any) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch (error) {
      throw new Error(`Invalid paper day-state JSON: ${String(error)}`);
    }

    // Backward-compatible migration for day-state files created before peak
    // equity became persistent. The original day-start equity is the safest
    // lower-bound historical peak available from that schema.
    if (
      value &&
      typeof value === "object" &&
      (value as Partial<PaperDayState>).schemaVersion === 1 &&
      (value as Partial<PaperDayState>).peakEquity === undefined &&
      Number.isFinite(Number((value as Partial<PaperDayState>).dayStartEquity))
    ) {
      value = {
        ...(value as Record<string, unknown>),
        peakEquity: Number((value as Partial<PaperDayState>).dayStartEquity),
      };
    }

    validatePaperDayState(value);
    return value;
  }

  private async write(value: PaperDayState): Promise<void> {
    validatePaperDayState(value);
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = this.filePath + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify(value) + "\n", "utf8");
    await rename(temporary, this.filePath);
  }

  private async serialized<T>(task: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.queue;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }
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
}

export class PaperPortfolio {
  private readonly positions = new Map<string, PaperPositionState>();
  private cashValue: number;
  private peakEquityValue: number;
  private totalFeesValue = 0;
  private readonly realizedPnlBySymbol = new Map<string, number>();

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

  assertCanApply(fill: TradeFill): void {
    validateTradeFill(fill);
    if (fill.mode !== "paper") {
      throw new Error("PaperPortfolio accepts paper fills only");
    }
    const current = this.positions.get(fill.symbol);
    if (fill.side === "BUY" && fill.notional + fill.fee > this.cashValue + 1e-9) {
      throw new Error(
        `Insufficient paper cash for ${fill.symbol}: required ${(fill.notional + fill.fee).toFixed(8)}, available ${this.cashValue.toFixed(8)}`
      );
    }
    if (fill.side === "SELL" && fill.quantity > (current?.quantity ?? 0) + 1e-12) {
      throw new Error(
        `PaperPortfolio cannot sell more ${fill.symbol} than the long position`
      );
    }
  }

  applyFill(fill: TradeFill): void {
    this.assertCanApply(fill);

    const current = this.positions.get(fill.symbol) ?? {
      quantity: 0,
      averageEntryPrice: 0,
    };

    if (fill.side === "BUY") {
      const requiredCash = fill.notional + fill.fee;
      const nextQuantity = current.quantity + fill.quantity;
      const weightedCost =
        current.averageEntryPrice * current.quantity + fill.price * fill.quantity;
      this.cashValue -= requiredCash;
      this.totalFeesValue += fill.fee;
      this.positions.set(fill.symbol, {
        quantity: nextQuantity,
        averageEntryPrice: weightedCost / nextQuantity,
      });
      return;
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
      });
    }

    this.realizedPnlBySymbol.set(
      fill.symbol,
      (this.realizedPnlBySymbol.get(fill.symbol) ?? 0) + realized
    );
  }

  snapshot(
    marks: Readonly<Record<string, number>> = {},
    historicalPeakEquity?: number
  ): PaperPortfolioSnapshot {
    const positions: PaperPositionSnapshot[] = [];
    let grossExposure = 0;
    let unrealizedPnl = 0;


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
      positions.push({
        symbol,
        quantity: position.quantity,
        averageEntryPrice: position.averageEntryPrice,
        marketPrice,
        marketValue,
        unrealizedPnl: unrealized,
        realizedPnl: this.realizedPnlBySymbol.get(symbol) ?? 0,
      });
    }

    const equity = this.cashValue + positions.reduce(
      (sum, position) => sum + position.marketValue,
      0
    );
    this.peakEquityValue = Math.max(
      this.peakEquityValue,
      Number.isFinite(historicalPeakEquity) ? Number(historicalPeakEquity) : 0,
      equity
    );
    const drawdownPct = this.peakEquityValue > 0
      ? ((this.peakEquityValue - equity) / this.peakEquityValue) * 100
      : 0;

    return {
      initialCash: this.initialCash,
      cash: this.cashValue,
      equity,
      peakEquity: this.peakEquityValue,
      realizedPnl: [...this.realizedPnlBySymbol.values()].reduce(
        (sum, value) => sum + value,
        0
      ),
      unrealizedPnl,
      totalFees: this.totalFeesValue,
      grossExposure,
      drawdownPct,
      positions,
    };
  }

  previewRiskStateAfterFill(
    fill: TradeFill,
    marks: Readonly<Record<string, number>> = {},
    dayStartEquity?: number,
    historicalPeakEquity?: number
  ): PortfolioState {
    const projected = this.clone();
    projected.applyFill(fill);
    return projected.toRiskState(
      marks,
      dayStartEquity,
      historicalPeakEquity
    );
  }

  private clone(): PaperPortfolio {
    const copy = new PaperPortfolio(this.initialCash);
    copy.cashValue = this.cashValue;
    copy.peakEquityValue = this.peakEquityValue;
    copy.totalFeesValue = this.totalFeesValue;
    for (const [symbol, position] of this.positions) {
      copy.positions.set(symbol, { ...position });
    }
    for (const [symbol, realizedPnl] of this.realizedPnlBySymbol) {
      copy.realizedPnlBySymbol.set(symbol, realizedPnl);
    }
    return copy;
  }

  toRiskState(
    marks: Readonly<Record<string, number>> = {},
    dayStartEquity?: number,
    historicalPeakEquity?: number
  ): PortfolioState {
    const snapshot = this.snapshot(marks, historicalPeakEquity);
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
  private appendQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {
    if (!filePath.trim()) throw new Error("Trade ledger path cannot be empty");
  }

  async append(fill: TradeFill): Promise<"inserted" | "duplicate"> {
    validateTradeFill(fill);

    let release!: () => void;
    const previous = this.appendQueue;
    this.appendQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      const rows = await this.list();
      const existing = rows.find((row) => row.id === fill.id);
      if (existing) {
        if (canonicalTrade(existing) === canonicalTrade(fill)) return "duplicate";
        throw new Error(`Conflicting trade fill id already exists: ${fill.id}`);
      }

      if (fill.mode === "live" && fill.externalId) {
        const external = rows.find(
          (row) =>
            row.mode === "live" &&
            row.source === "broker" &&
            row.externalId === fill.externalId
        );
        if (external) {
          const sameExecution =
            external.symbol === fill.symbol &&
            external.side === fill.side &&
            external.price === fill.price &&
            external.quantity === fill.quantity &&
            external.fee === fill.fee;
          if (sameExecution) return "duplicate";
          throw new Error(
            `Conflicting broker externalId already exists: ${fill.externalId}`
          );
        }
      }

      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, JSON.stringify(fill) + "\n", "utf8");
      return "inserted";
    } finally {
      release();
    }
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
  private executionQueue: Promise<void> = Promise.resolve();
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

  async executeFromLedger(
    order: ProposedOrder,
    initialCash: number,
    riskEngine: RiskEngine,
    marks: Readonly<Record<string, number>> = {},
    dayStartEquity?: number,
    historicalPeakEquity?: number
  ): Promise<PaperExecutionResult> {
    return this.serializedExecution(async () => {
      const portfolio = await rebuildPaperPortfolio(this.ledger, initialCash);
      return this.executeAgainstPortfolio(
        order,
        portfolio,
        riskEngine,
        marks,
        dayStartEquity,
        historicalPeakEquity
      );
    });
  }

  private async executeAgainstPortfolio(
    order: ProposedOrder,
    portfolio: PaperPortfolio,
    riskEngine: RiskEngine,
    marks: Readonly<Record<string, number>> = {},
    dayStartEquity?: number,
    historicalPeakEquity?: number
  ): Promise<PaperExecutionResult> {
    if (riskEngine.getMode() !== "paper") {
      throw new Error("PaperExecutor requires RiskEngine mode=paper");
    }

    const state = portfolio.toRiskState(
      marks,
      dayStartEquity,
      historicalPeakEquity
    );
    const executionPrice = this.executionPrice(order);
    // PaperPortfolio is deliberately long-only. Canonicalize reduce-only intent
    // from settlement semantics rather than trusting a caller-provided flag:
    // every SELL reduces an existing long; BUY can never be reduce-only.
    const riskOrder: ProposedOrder = {
      ...order,
      price: executionPrice,
      reduceOnly: order.side === "SELL",
    };
    const risk = riskEngine.evaluateOrder(riskOrder, state);
    if (!risk.approved) {
      return {
        risk,
        portfolio: portfolio.snapshot(marks, historicalPeakEquity),
      };
    }

    const fill = this.buildFill(order, executionPrice);

    // Validate cash/position constraints and the exact post-settlement risk
    // state before persistence. Fees/slippage can push a portfolio across a
    // daily-loss, drawdown, or exposure boundary even when the pre-order state
    // itself is still inside the limit.
    portfolio.assertCanApply(fill);
    const projectedState = portfolio.previewRiskStateAfterFill(
      fill,
      marks,
      dayStartEquity,
      historicalPeakEquity
    );
    const projectedRisk = evaluateProjectedPaperState(
      riskEngine,
      projectedState,
      order.symbol
    );
    if (!projectedRisk.approved) {
      return {
        risk: projectedRisk,
        portfolio: portfolio.snapshot(marks, historicalPeakEquity),
      };
    }

    const appendResult = await this.ledger.append(fill);
    if (appendResult === "inserted") {
      portfolio.applyFill(fill);
    }
    return {
      risk: projectedRisk,
      fill,
      portfolio: portfolio.snapshot(marks, historicalPeakEquity),
    };
  }

  private async serializedExecution<T>(task: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.executionQueue;
    this.executionQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }

  private executionPrice(order: ProposedOrder): number {
    const slip = this.slippageBps / 10_000;
    return order.side === "BUY"
      ? order.price * (1 + slip)
      : order.price * (1 - slip);
  }

  private buildFill(order: ProposedOrder, price = this.executionPrice(order)): TradeFill {
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

export function validatePaperDayState(value: unknown): asserts value is PaperDayState {
  if (!value || typeof value !== "object") throw new Error("Paper day state must be an object");
  const state = value as Partial<PaperDayState>;
  if (state.schemaVersion !== 1) throw new Error("Unsupported paper day-state schemaVersion");
  if (typeof state.utcDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(state.utcDate)) {
    throw new Error("Paper day-state utcDate must use YYYY-MM-DD");
  }
  if (!Number.isFinite(state.dayStartEquity) || Number(state.dayStartEquity) <= 0) {
    throw new Error("Paper day-state dayStartEquity must be positive");
  }
  if (
    !Number.isFinite(state.peakEquity) ||
    Number(state.peakEquity) < Number(state.dayStartEquity)
  ) {
    throw new Error("Paper day-state peakEquity must be >= dayStartEquity");
  }
  if (!Number.isSafeInteger(state.createdAt) || Number(state.createdAt) <= 0) {
    throw new Error("Paper day-state createdAt must be a positive integer");
  }
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
  if (fill.mode === "paper" && fill.source !== "paper-executor") {
    throw new Error("Paper trade fill source must be paper-executor");
  }
  if (fill.mode === "live" && fill.source !== "broker") {
    throw new Error("Live trade fill source must be broker");
  }
  if (
    fill.externalId !== undefined &&
    (typeof fill.externalId !== "string" || !fill.externalId.trim())
  ) {
    throw new Error("Trade fill externalId must be a non-empty string when provided");
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
  const expectedNotional = Number(fill.price) * Number(fill.quantity);
  const notionalTolerance = Math.max(1e-8, Math.abs(expectedNotional) * 1e-8);
  if (Math.abs(Number(fill.notional) - expectedNotional) > notionalTolerance) {
    throw new Error("Trade fill notional must equal price × quantity");
  }
  if (!Number.isFinite(fill.fee) || Number(fill.fee) < 0) {
    throw new Error("Trade fill fee must be non-negative");
  }
  if (typeof fill.strategyId !== "string" || !fill.strategyId.trim()) {
    throw new Error("Trade fill strategyId is required");
  }
}

function evaluateProjectedPaperState(
  riskEngine: RiskEngine,
  state: PortfolioState,
  symbol: string
): RiskDecision {
  const limits = riskEngine.getLimits();

  if (state.dailyPnlPct <= -limits.maxDailyLossPct) {
    return { approved: false, reason: "DAILY_LOSS_LIMIT" };
  }
  if (state.drawdownPct >= limits.maxDrawdownPct) {
    riskEngine.activateKillSwitch();
    return { approved: false, reason: "MAX_DRAWDOWN" };
  }
  if (state.totalExposurePct > limits.maxPortfolioExposurePct) {
    return { approved: false, reason: "MAX_PORTFOLIO_EXPOSURE" };
  }

  const symbolExposure = state.symbolExposures.get(symbol) ?? 0;
  if (symbolExposure > limits.maxSymbolExposurePct) {
    return { approved: false, reason: "MAX_SYMBOL_EXPOSURE" };
  }

  return {
    approved: true,
    projectedPortfolioExposurePct: state.totalExposurePct,
    projectedSymbolExposurePct: symbolExposure,
  };
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
