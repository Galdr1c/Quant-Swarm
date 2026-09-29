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

    const slip = this.slippageBps / 10_000;
    const price = order.side === "BUY"
      ? order.price * (1 + slip)
      : order.price * (1 - slip);
    const notional = price * order.quantity;
    const fee = notional * (this.feeBps / 10_000);
    const fill: TradeFill = {
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

    await this.ledger.append(fill);
    return { risk, fill };
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
