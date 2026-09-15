import TradingView from "@mathieuc/tradingview";
import type { OHLCV } from "@quant-swarm/shared";
import type {
  CandleHandler,
  CandleStream,
  CandleStreamOptions,
  CandleSubscription,
  MarketCandle,
  StreamingMarketDataProvider,
} from "./types.js";

export type TradingViewMarketType =
  | "stock"
  | "futures"
  | "forex"
  | "cfd"
  | "crypto"
  | "index"
  | "economic"
  | "";

export interface TradingViewMarketSearchResult {
  id: string;
  exchange: string;
  fullExchange: string;
  symbol: string;
  description: string;
  type: string;
}

export interface TradingViewClientOptions {
  token?: string;
  signature?: string;
  server?: "data" | "prodata" | "widgetdata";
  headers?: Record<string, string>;
  location?: string;
}

export interface TradingViewProviderOptions extends TradingViewClientOptions {
  session?: "regular" | "extended";
  adjustment?: "splits" | "dividends";
  requestTimeoutMs?: number;
  settleMs?: number;
  maxHistoryBars?: number;
  includeCurrentHistoricalBar?: boolean;
  clientFactory?: TradingViewClientFactory;
}

export interface TradingViewPricePeriod {
  time: number;
  open: number;
  close: number;
  max: number;
  min: number;
  volume: number;
}

export interface TradingViewChartLike {
  periods: TradingViewPricePeriod[];
  setMarket(symbol: string, options?: Record<string, unknown>): void;
  onUpdate(callback: (...args: unknown[]) => void): void;
  onError(callback: (...args: unknown[]) => void): void;
  delete(): void;
}

export interface TradingViewClientLike {
  Session: {
    Chart: new () => TradingViewChartLike;
  };
  end(): Promise<void> | void;
  onDisconnected?(callback: () => void): void;
  onError?(callback: (...args: unknown[]) => void): void;
}

export type TradingViewClientFactory = (
  options: TradingViewClientOptions
) => TradingViewClientLike;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_SETTLE_MS = 125;
const DEFAULT_MAX_HISTORY = 5_000;

/**
 * Universal candle provider backed by the community `@mathieuc/tradingview`
 * client. It is intentionally used for chart/candle discovery only; exchange
 * microstructure adapters remain separate because TradingView is not the source
 * of truth for order-book, liquidation, funding and venue execution state.
 */
export class TradingViewMarketDataProvider implements StreamingMarketDataProvider {
  readonly name = "tradingview" as const;

  private readonly options: Required<Pick<
    TradingViewProviderOptions,
    "requestTimeoutMs" | "settleMs" | "maxHistoryBars" | "includeCurrentHistoricalBar"
  >> & TradingViewProviderOptions;

  private readonly clientFactory: TradingViewClientFactory;

  constructor(options: TradingViewProviderOptions = {}) {
    this.options = {
      ...options,
      requestTimeoutMs: positiveInteger(options.requestTimeoutMs, DEFAULT_TIMEOUT_MS, "requestTimeoutMs"),
      settleMs: positiveInteger(options.settleMs, DEFAULT_SETTLE_MS, "settleMs"),
      maxHistoryBars: positiveInteger(options.maxHistoryBars, DEFAULT_MAX_HISTORY, "maxHistoryBars"),
      includeCurrentHistoricalBar: options.includeCurrentHistoricalBar ?? false,
    };
    this.clientFactory = options.clientFactory ?? defaultTradingViewClientFactory;
  }

  async getHistoricalOHLCV(
    symbol: string,
    timeframe: string,
    limit: number
  ): Promise<OHLCV[]> {
    const normalizedSymbol = normalizeTradingViewSymbol(symbol);
    const normalizedTimeframe = normalizeCanonicalTimeframe(timeframe);
    const tvTimeframe = toTradingViewTimeframe(normalizedTimeframe);
    const safeLimit = boundedPositiveInteger(limit, this.options.maxHistoryBars, "limit");
    const extraCurrentBar = this.options.includeCurrentHistoricalBar ? 0 : 1;
    const requestRange = Math.min(
      this.options.maxHistoryBars,
      safeLimit + extraCurrentBar
    );

    const client = this.createClient();
    const chart = new client.Session.Chart();

    try {
      const rows = await waitForChartHistory(chart, {
        symbol: normalizedSymbol,
        tvTimeframe,
        requestRange,
        requestTimeoutMs: this.options.requestTimeoutMs,
        settleMs: this.options.settleMs,
        session: this.options.session,
        adjustment: this.options.adjustment,
      });

      const closedRows = this.options.includeCurrentHistoricalBar
        ? rows
        : rows.slice(0, -1);
      return closedRows.slice(-safeLimit);
    } finally {
      safelyDeleteChart(chart);
      await Promise.resolve(client.end()).catch(() => undefined);
    }
  }

  subscribeCandles(
    subscriptions: CandleSubscription[],
    handler: CandleHandler,
    options: CandleStreamOptions = {}
  ): CandleStream {
    if (subscriptions.length === 0) throw new Error("TradingView subscriptions cannot be empty");
    const normalized = subscriptions.map((subscription) => ({
      symbol: normalizeTradingViewSymbol(subscription.symbol),
      timeframe: normalizeCanonicalTimeframe(subscription.timeframe),
    }));
    return new TradingViewCandleStream(
      () => this.createClient(),
      normalized,
      handler,
      {
        ...options,
        session: this.options.session,
        adjustment: this.options.adjustment,
      }
    );
  }

  private createClient(): TradingViewClientLike {
    return this.clientFactory({
      token: this.options.token,
      signature: this.options.signature,
      server: this.options.server,
      headers: this.options.headers,
      location: this.options.location,
    });
  }
}

export async function searchTradingViewMarkets(
  query: string,
  filter: TradingViewMarketType = "",
  offset = 0
): Promise<TradingViewMarketSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("TradingView market search query cannot be empty");
  if (!Number.isInteger(offset) || offset < 0) throw new Error("TradingView market search offset must be >= 0");
  const rows = await TradingView.searchMarketV3(trimmed, filter, offset);
  return rows.map((row) => ({
    id: row.id,
    exchange: row.exchange,
    fullExchange: row.fullExchange,
    symbol: row.symbol,
    description: row.description,
    type: row.type,
  }));
}

export function toTradingViewTimeframe(timeframe: string): string {
  const value = normalizeCanonicalTimeframe(timeframe);
  if (/^\d+$/.test(value)) return value;
  if (value === "D" || value === "W" || value === "M") return value;

  let match = value.match(/^(\d+)m$/);
  if (match) return String(Number(match[1]));

  match = value.match(/^(\d+)h$/);
  if (match) return String(Number(match[1]) * 60);

  match = value.match(/^(\d+)d$/i);
  if (match) return Number(match[1]) === 1 ? "D" : `${Number(match[1])}D`;

  match = value.match(/^(\d+)w$/i);
  if (match) return Number(match[1]) === 1 ? "W" : `${Number(match[1])}W`;

  match = value.match(/^(\d+)M$/);
  if (match) return Number(match[1]) === 1 ? "M" : `${Number(match[1])}M`;

  throw new Error(`Unsupported TradingView timeframe: ${timeframe}`);
}

export function normalizeTradingViewSymbol(symbol: string): string {
  const value = symbol.trim().toUpperCase();
  if (!value) throw new Error("TradingView symbol cannot be empty");
  if (!value.includes(":")) {
    throw new Error(
      `TradingView symbols must be exchange-qualified (for example NASDAQ:AAPL or BINANCE:BTCUSDT): ${symbol}`
    );
  }
  return value;
}

export function normalizeTradingViewPeriods(periods: readonly TradingViewPricePeriod[]): OHLCV[] {
  const deduped = new Map<number, OHLCV>();
  for (const period of periods) {
    const row = periodToOHLCV(period);
    if (row) deduped.set(row.timestamp, row);
  }
  return [...deduped.values()].sort((a, b) => a.timestamp - b.timestamp);
}

interface HistoryWaitOptions {
  symbol: string;
  tvTimeframe: string;
  requestRange: number;
  requestTimeoutMs: number;
  settleMs: number;
  session?: "regular" | "extended";
  adjustment?: "splits" | "dividends";
}

function waitForChartHistory(
  chart: TradingViewChartLike,
  options: HistoryWaitOptions
): Promise<OHLCV[]> {
  return new Promise((resolve, reject) => {
    let finished = false;
    let best: OHLCV[] = [];
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      finishError(new Error(`TradingView history timed out for ${options.symbol}`));
    }, options.requestTimeoutMs);
    timeout.unref?.();

    const cleanup = (): void => {
      clearTimeout(timeout);
      if (settleTimer) clearTimeout(settleTimer);
    };

    const finishSuccess = (): void => {
      if (finished) return;
      finished = true;
      cleanup();
      if (best.length === 0) {
        reject(new Error(`TradingView returned no candles for ${options.symbol}`));
        return;
      }
      resolve(best);
    };

    const finishError = (error: Error): void => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
    };

    chart.onError((...args) => {
      finishError(new Error(`TradingView chart error for ${options.symbol}: ${args.map(String).join(" ")}`));
    });

    chart.onUpdate(() => {
      const rows = normalizeTradingViewPeriods(chart.periods);
      if (rows.length === 0) return;
      if (rows.length >= best.length) best = rows;
      if (best.length >= options.requestRange) {
        finishSuccess();
        return;
      }
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(finishSuccess, options.settleMs);
      settleTimer.unref?.();
    });

    chart.setMarket(options.symbol, compactObject({
      timeframe: options.tvTimeframe,
      range: options.requestRange,
      session: options.session,
      adjustment: options.adjustment,
    }));
  });
}

interface TradingViewStreamOptions extends CandleStreamOptions {
  session?: "regular" | "extended";
  adjustment?: "splits" | "dividends";
}

class TradingViewCandleStream implements CandleStream {
  private isClosed = false;
  private client?: TradingViewClientLike;
  private charts: TradingViewChartLike[] = [];
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;
  private readonly lastClosed = new Map<string, number>();
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly backfillLimit: number;

  constructor(
    private readonly clientFactory: () => TradingViewClientLike,
    private readonly subscriptions: CandleSubscription[],
    private readonly handler: CandleHandler,
    private readonly options: TradingViewStreamOptions
  ) {
    this.reconnectBaseMs = positiveInteger(options.reconnectBaseMs, 1_000, "reconnectBaseMs");
    this.reconnectMaxMs = positiveInteger(options.reconnectMaxMs, 30_000, "reconnectMaxMs");
    this.backfillLimit = positiveInteger(options.backfillLimit, 5, "backfillLimit");
    this.connect();
  }

  get closed(): boolean {
    return this.isClosed;
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.cleanupClient();
  }

  private connect(): void {
    if (this.isClosed) return;
    this.cleanupClient();

    let client: TradingViewClientLike;
    try {
      client = this.clientFactory();
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.client = client;

    client.onDisconnected?.(() => {
      if (this.client !== client || this.isClosed) return;
      this.scheduleReconnect();
    });

    for (const subscription of this.subscriptions) {
      const chart = new client.Session.Chart();
      this.charts.push(chart);
      const key = streamKey(subscription);

      chart.onError(() => {
        // Symbol-level errors should not tear down unrelated chart sessions.
      });
      chart.onUpdate(() => {
        this.reconnectAttempt = 0;
        const rows = normalizeTradingViewPeriods(chart.periods);
        if (rows.length < 2) return;
        const closedRows = rows.slice(0, -1).slice(-this.backfillLimit);
        const previous = this.lastClosed.get(key);
        for (const row of closedRows) {
          if (previous !== undefined && row.timestamp <= (this.lastClosed.get(key) ?? previous)) continue;
          this.lastClosed.set(key, row.timestamp);
          const candle: MarketCandle = {
            ...row,
            exchange: "tradingview",
            symbol: subscription.symbol,
            timeframe: subscription.timeframe,
            closed: true,
          };
          void Promise.resolve(this.handler(candle)).catch(() => undefined);
        }
      });
      chart.setMarket(subscription.symbol, compactObject({
        timeframe: toTradingViewTimeframe(subscription.timeframe),
        range: this.backfillLimit + 1,
        session: this.options.session,
        adjustment: this.options.adjustment,
      }));
    }
  }

  private scheduleReconnect(): void {
    if (this.isClosed || this.reconnectTimer) return;
    this.cleanupClient();
    const delay = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * 2 ** Math.min(this.reconnectAttempt, 8)
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private cleanupClient(): void {
    const charts = this.charts;
    this.charts = [];
    for (const chart of charts) safelyDeleteChart(chart);
    const client = this.client;
    this.client = undefined;
    if (client) void Promise.resolve(client.end()).catch(() => undefined);
  }
}

function defaultTradingViewClientFactory(options: TradingViewClientOptions): TradingViewClientLike {
  return new TradingView.Client(compactObject(options)) as TradingViewClientLike;
}

function periodToOHLCV(period: TradingViewPricePeriod): OHLCV | undefined {
  const values = [period.time, period.open, period.max, period.min, period.close, period.volume];
  if (!values.every((value) => Number.isFinite(value))) return undefined;
  if (period.time <= 0) return undefined;
  const timestamp = period.time >= 1_000_000_000_000
    ? Math.trunc(period.time)
    : Math.trunc(period.time * 1_000);
  return {
    timestamp,
    open: Number(period.open),
    high: Number(period.max),
    low: Number(period.min),
    close: Number(period.close),
    volume: Number(period.volume),
  };
}

function normalizeCanonicalTimeframe(timeframe: string): string {
  const value = timeframe.trim();
  if (!value) throw new Error("timeframe cannot be empty");
  return value;
}

function streamKey(subscription: CandleSubscription): string {
  return `${subscription.symbol.toUpperCase()}\u0000${subscription.timeframe}`;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) throw new Error(`${name} must be a positive integer`);
  return resolved;
}

function boundedPositiveInteger(value: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return Math.min(value, max);
}

function safelyDeleteChart(chart: TradingViewChartLike): void {
  try {
    chart.delete();
  } catch {
    // Best-effort cleanup after remote/session errors.
  }
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  ) as T;
}
