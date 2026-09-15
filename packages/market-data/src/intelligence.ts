import { createDefaultWebSocketFactory } from "./resilient-stream.js";
import type {
  ExchangeName,
  FetchLike,
  WebSocketFactory,
  WebSocketLike,
} from "./types.js";

export type IntelligenceExchange = Exclude<ExchangeName, "synthetic">;

export interface OrderBookLevel {
  price: number;
  size: number;
  notionalUsd: number;
}

export interface LiquidationEvent {
  exchange: IntelligenceExchange;
  symbol: string;
  timestamp: number;
  side: "LONG" | "SHORT";
  price: number;
  size: number;
  notionalUsd: number;
}

export interface MarketIntelligenceSnapshot {
  exchange: IntelligenceExchange;
  symbol: string;
  timestamp: number;
  bestBid: number;
  bestAsk: number;
  midPrice: number;
  spreadBps: number;
  bidDepthUsd: number;
  askDepthUsd: number;
  orderBookImbalance: number;
  fundingRate: number | null;
  nextFundingTime: number | null;
  openInterest: number | null;
  openInterestUsd: number | null;
  markPrice: number | null;
  indexPrice: number | null;
  basisBps: number | null;
  liquidationLongUsd: number | null;
  liquidationShortUsd: number | null;
  sourceLatencyMs: number | null;
}

export interface IntelligenceStream {
  close(): void;
  readonly closed: boolean;
}

export type LiquidationHandler = (event: LiquidationEvent) => void | Promise<void>;

export interface MarketIntelligenceProvider {
  readonly name: IntelligenceExchange;
  getSnapshot(symbol: string): Promise<MarketIntelligenceSnapshot>;
  subscribeLiquidations?(
    symbols: string[],
    handler?: LiquidationHandler
  ): IntelligenceStream | undefined;
}

export interface IntelligenceProviderOptions {
  fetchImpl?: FetchLike;
  webSocketFactory?: WebSocketFactory;
  depthLimit?: number;
  liquidationWindowMs?: number;
}

export interface BinanceFuturesIntelligenceOptions extends IntelligenceProviderOptions {
  restBaseUrl?: string;
  wsBaseUrl?: string;
}

export interface BybitIntelligenceOptions extends IntelligenceProviderOptions {
  category?: "linear" | "inverse";
  restBaseUrl?: string;
  wsBaseUrl?: string;
}

export interface HyperliquidIntelligenceOptions extends IntelligenceProviderOptions {
  restUrl?: string;
}

const OPEN = 1;

class LiquidationWindow {
  private readonly events = new Map<string, LiquidationEvent[]>();
  private readonly activeSymbols = new Set<string>();

  constructor(private readonly windowMs: number) {}

  activate(symbols: string[]): void {
    for (const symbol of symbols) this.activeSymbols.add(symbol.toUpperCase());
  }

  record(event: LiquidationEvent): void {
    const key = event.symbol.toUpperCase();
    const rows = this.events.get(key) ?? [];
    rows.push(event);
    this.events.set(key, rows);
    this.prune(key, event.timestamp);
  }

  totals(symbol: string, now: number): { longUsd: number | null; shortUsd: number | null } {
    const key = symbol.toUpperCase();
    if (!this.activeSymbols.has(key)) return { longUsd: null, shortUsd: null };
    this.prune(key, now);
    const rows = this.events.get(key) ?? [];
    return {
      longUsd: rows.filter((e) => e.side === "LONG").reduce((sum, e) => sum + e.notionalUsd, 0),
      shortUsd: rows.filter((e) => e.side === "SHORT").reduce((sum, e) => sum + e.notionalUsd, 0),
    };
  }

  private prune(symbol: string, now: number): void {
    const cutoff = now - this.windowMs;
    const rows = (this.events.get(symbol) ?? []).filter((e) => e.timestamp >= cutoff);
    this.events.set(symbol, rows);
  }
}

interface JsonReconnectOptions {
  url: string;
  socketFactory: WebSocketFactory;
  parseMessage: (payload: unknown) => LiquidationEvent[];
  handler: LiquidationHandler;
  onOpen?: (socket: WebSocketLike) => void;
  heartbeatMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

class JsonReconnectStream implements IntelligenceStream {
  private socket?: WebSocketLike;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private reconnectAttempt = 0;
  private manuallyClosed = false;

  constructor(private readonly options: JsonReconnectOptions) {
    this.connect();
  }

  get closed(): boolean {
    return this.manuallyClosed;
  }

  close(): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.socket?.close();
  }

  private connect(): void {
    if (this.manuallyClosed) return;
    const socket = this.options.socketFactory(this.options.url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      this.options.onOpen?.(socket);
      if (this.options.heartbeatMs) {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => {
          if (socket.readyState === OPEN) socket.send(JSON.stringify({ op: "ping" }));
        }, this.options.heartbeatMs);
      }
    });

    socket.addEventListener("message", (event: any) => {
      let payload: unknown = event?.data ?? event;
      if (typeof payload === "string") {
        try {
          payload = JSON.parse(payload);
        } catch {
          return;
        }
      }
      for (const liquidation of this.options.parseMessage(payload)) {
        void this.options.handler(liquidation);
      }
    });

    socket.addEventListener("close", () => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
      if (!this.manuallyClosed) this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      if (!this.manuallyClosed && socket.readyState === OPEN) socket.close();
    });
  }

  private scheduleReconnect(): void {
    const base = this.options.reconnectBaseMs ?? 1_000;
    const max = this.options.reconnectMaxMs ?? 30_000;
    const delay = Math.min(max, base * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

export class BinanceFuturesIntelligenceProvider implements MarketIntelligenceProvider {
  readonly name = "binance" as const;
  private readonly restBaseUrl: string;
  private readonly wsBaseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly socketFactory: WebSocketFactory;
  private readonly depthLimit: number;
  private readonly liquidations: LiquidationWindow;

  constructor(options: BinanceFuturesIntelligenceOptions = {}) {
    this.restBaseUrl = options.restBaseUrl ?? "https://fapi.binance.com";
    this.wsBaseUrl = options.wsBaseUrl ?? "wss://fstream.binance.com/market";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.socketFactory = options.webSocketFactory ?? createDefaultWebSocketFactory();
    this.depthLimit = clampDepth(options.depthLimit ?? 50, [5, 10, 20, 50, 100, 500, 1000]);
    this.liquidations = new LiquidationWindow(options.liquidationWindowMs ?? 60_000);
  }

  async getSnapshot(symbol: string): Promise<MarketIntelligenceSnapshot> {
    const normalized = symbol.toUpperCase();
    const depthUrl = new URL("/fapi/v1/depth", this.restBaseUrl);
    depthUrl.searchParams.set("symbol", normalized);
    depthUrl.searchParams.set("limit", String(this.depthLimit));
    const premiumUrl = new URL("/fapi/v1/premiumIndex", this.restBaseUrl);
    premiumUrl.searchParams.set("symbol", normalized);
    const openInterestUrl = new URL("/fapi/v1/openInterest", this.restBaseUrl);
    openInterestUrl.searchParams.set("symbol", normalized);

    const [depth, premium, openInterest] = await Promise.all([
      getJson(this.fetchImpl, depthUrl, "Binance depth"),
      getJson(this.fetchImpl, premiumUrl, "Binance premium index"),
      getJson(this.fetchImpl, openInterestUrl, "Binance open interest"),
    ]);

    const timestamp = latestTimestamp(depth?.T, depth?.E, premium?.time, openInterest?.time);
    const liquidation = this.liquidations.totals(normalized, timestamp);
    return buildSnapshot({
      exchange: "binance",
      symbol: normalized,
      timestamp,
      bids: normalizeBookLevels(depth?.bids),
      asks: normalizeBookLevels(depth?.asks),
      fundingRate: numberOrNull(premium?.lastFundingRate),
      nextFundingTime: numberOrNull(premium?.nextFundingTime),
      openInterest: numberOrNull(openInterest?.openInterest),
      markPrice: numberOrNull(premium?.markPrice),
      indexPrice: numberOrNull(premium?.indexPrice),
      liquidationLongUsd: liquidation.longUsd,
      liquidationShortUsd: liquidation.shortUsd,
    });
  }

  subscribeLiquidations(symbols: string[], handler?: LiquidationHandler): IntelligenceStream {
    const normalized = symbols.map((s) => s.toUpperCase());
    this.liquidations.activate(normalized);
    const streams = normalized.map((s) => `${s.toLowerCase()}@forceOrder`).join("/");
    const url = `${this.wsBaseUrl.replace(/\/$/, "")}/stream?streams=${streams}`;
    return new JsonReconnectStream({
      url,
      socketFactory: this.socketFactory,
      parseMessage: parseBinanceLiquidationMessage,
      handler: async (event) => {
        this.liquidations.record(event);
        await handler?.(event);
      },
    });
  }
}

export class BybitIntelligenceProvider implements MarketIntelligenceProvider {
  readonly name = "bybit" as const;
  private readonly category: "linear" | "inverse";
  private readonly restBaseUrl: string;
  private readonly wsBaseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly socketFactory: WebSocketFactory;
  private readonly depthLimit: number;
  private readonly liquidations: LiquidationWindow;

  constructor(options: BybitIntelligenceOptions = {}) {
    this.category = options.category ?? "linear";
    this.restBaseUrl = options.restBaseUrl ?? "https://api.bybit.com";
    this.wsBaseUrl = options.wsBaseUrl ?? `wss://stream.bybit.com/v5/public/${this.category}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.socketFactory = options.webSocketFactory ?? createDefaultWebSocketFactory();
    this.depthLimit = Math.max(1, Math.min(options.depthLimit ?? 50, 1000));
    this.liquidations = new LiquidationWindow(options.liquidationWindowMs ?? 60_000);
  }

  async getSnapshot(symbol: string): Promise<MarketIntelligenceSnapshot> {
    const normalized = symbol.toUpperCase();
    const orderbookUrl = new URL("/v5/market/orderbook", this.restBaseUrl);
    orderbookUrl.searchParams.set("category", this.category);
    orderbookUrl.searchParams.set("symbol", normalized);
    orderbookUrl.searchParams.set("limit", String(this.depthLimit));
    const tickerUrl = new URL("/v5/market/tickers", this.restBaseUrl);
    tickerUrl.searchParams.set("category", this.category);
    tickerUrl.searchParams.set("symbol", normalized);

    const [bookBody, tickerBody] = await Promise.all([
      getJson(this.fetchImpl, orderbookUrl, "Bybit orderbook"),
      getJson(this.fetchImpl, tickerUrl, "Bybit ticker"),
    ]);
    assertBybitOk(bookBody, "orderbook");
    assertBybitOk(tickerBody, "ticker");
    const book = bookBody.result;
    const ticker = tickerBody.result?.list?.[0];
    if (!ticker) throw new Error("Bybit ticker returned no rows");

    const timestamp = latestTimestamp(book?.ts, book?.cts, bookBody?.time, tickerBody?.time);
    const liquidation = this.liquidations.totals(normalized, timestamp);
    return buildSnapshot({
      exchange: "bybit",
      symbol: normalized,
      timestamp,
      bids: normalizeBookLevels(book?.b),
      asks: normalizeBookLevels(book?.a),
      fundingRate: numberOrNull(ticker?.fundingRate),
      nextFundingTime: numberOrNull(ticker?.nextFundingTime),
      openInterest: numberOrNull(ticker?.openInterest),
      openInterestUsd: numberOrNull(ticker?.openInterestValue),
      markPrice: numberOrNull(ticker?.markPrice),
      indexPrice: numberOrNull(ticker?.indexPrice),
      liquidationLongUsd: liquidation.longUsd,
      liquidationShortUsd: liquidation.shortUsd,
    });
  }

  subscribeLiquidations(symbols: string[], handler?: LiquidationHandler): IntelligenceStream {
    const normalized = symbols.map((s) => s.toUpperCase());
    this.liquidations.activate(normalized);
    return new JsonReconnectStream({
      url: this.wsBaseUrl,
      socketFactory: this.socketFactory,
      onOpen: (socket) => {
        socket.send(JSON.stringify({
          op: "subscribe",
          args: normalized.map((s) => `allLiquidation.${s}`),
        }));
      },
      heartbeatMs: 20_000,
      parseMessage: parseBybitLiquidationMessage,
      handler: async (event) => {
        this.liquidations.record(event);
        await handler?.(event);
      },
    });
  }
}

export class HyperliquidIntelligenceProvider implements MarketIntelligenceProvider {
  readonly name = "hyperliquid" as const;
  private readonly restUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: HyperliquidIntelligenceOptions = {}) {
    this.restUrl = options.restUrl ?? "https://api.hyperliquid.xyz/info";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getSnapshot(symbol: string): Promise<MarketIntelligenceSnapshot> {
    const coin = normalizeHyperliquidCoin(symbol);
    const [book, metaAndCtxs] = await Promise.all([
      postJson(this.fetchImpl, this.restUrl, { type: "l2Book", coin }, "Hyperliquid l2Book"),
      postJson(this.fetchImpl, this.restUrl, { type: "metaAndAssetCtxs" }, "Hyperliquid metaAndAssetCtxs"),
    ]);

    if (!Array.isArray(metaAndCtxs) || metaAndCtxs.length < 2) {
      throw new Error("Invalid Hyperliquid metaAndAssetCtxs response");
    }
    const meta = metaAndCtxs[0];
    const contexts = metaAndCtxs[1];
    const index = Array.isArray(meta?.universe)
      ? meta.universe.findIndex((asset: any) => String(asset?.name).toUpperCase() === coin)
      : -1;
    if (index < 0 || !Array.isArray(contexts) || !contexts[index]) {
      throw new Error(`Hyperliquid asset not found: ${coin}`);
    }
    const ctx = contexts[index];
    const levels = Array.isArray(book?.levels) ? book.levels : [];
    return buildSnapshot({
      exchange: "hyperliquid",
      symbol: coin,
      timestamp: latestTimestamp(book?.time),
      bids: normalizeBookLevels(levels[0]),
      asks: normalizeBookLevels(levels[1]),
      fundingRate: numberOrNull(ctx?.funding),
      nextFundingTime: null,
      openInterest: numberOrNull(ctx?.openInterest),
      markPrice: numberOrNull(ctx?.markPx),
      indexPrice: numberOrNull(ctx?.oraclePx),
      liquidationLongUsd: null,
      liquidationShortUsd: null,
    });
  }
}

interface SnapshotInput {
  exchange: IntelligenceExchange;
  symbol: string;
  timestamp: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  fundingRate: number | null;
  nextFundingTime: number | null;
  openInterest: number | null;
  openInterestUsd?: number | null;
  markPrice: number | null;
  indexPrice: number | null;
  liquidationLongUsd: number | null;
  liquidationShortUsd: number | null;
}

export function buildSnapshot(input: SnapshotInput): MarketIntelligenceSnapshot {
  const bestBid = input.bids[0]?.price;
  const bestAsk = input.asks[0]?.price;
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) {
    throw new Error(`${input.exchange} ${input.symbol} orderbook is empty`);
  }
  const midPrice = (bestBid + bestAsk) / 2;
  const bidDepthUsd = input.bids.reduce((sum, level) => sum + level.notionalUsd, 0);
  const askDepthUsd = input.asks.reduce((sum, level) => sum + level.notionalUsd, 0);
  const totalDepth = bidDepthUsd + askDepthUsd;
  const markPrice = input.markPrice;
  const openInterestUsd = input.openInterestUsd ?? (
    input.openInterest !== null && markPrice !== null ? input.openInterest * markPrice : null
  );
  const now = Date.now();

  return {
    exchange: input.exchange,
    symbol: input.symbol.toUpperCase(),
    timestamp: input.timestamp,
    bestBid,
    bestAsk,
    midPrice,
    spreadBps: midPrice > 0 ? ((bestAsk - bestBid) / midPrice) * 10_000 : 0,
    bidDepthUsd,
    askDepthUsd,
    orderBookImbalance: totalDepth > 0 ? (bidDepthUsd - askDepthUsd) / totalDepth : 0,
    fundingRate: input.fundingRate,
    nextFundingTime: input.nextFundingTime,
    openInterest: input.openInterest,
    openInterestUsd,
    markPrice,
    indexPrice: input.indexPrice,
    basisBps: basisBps(markPrice, input.indexPrice),
    liquidationLongUsd: input.liquidationLongUsd,
    liquidationShortUsd: input.liquidationShortUsd,
    sourceLatencyMs: input.timestamp > 0 ? Math.max(0, now - input.timestamp) : null,
  };
}

export function normalizeBookLevels(rows: unknown): OrderBookLevel[] {
  if (!Array.isArray(rows)) return [];
  const result: OrderBookLevel[] = [];
  for (const row of rows) {
    const price = Array.isArray(row) ? Number(row[0]) : Number((row as any)?.px);
    const size = Array.isArray(row) ? Number(row[1]) : Number((row as any)?.sz);
    if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size < 0) continue;
    result.push({ price, size, notionalUsd: price * size });
  }
  return result;
}

export function basisBps(markPrice: number | null, indexPrice: number | null): number | null {
  if (markPrice === null || indexPrice === null || indexPrice === 0) return null;
  return ((markPrice - indexPrice) / indexPrice) * 10_000;
}

export function parseBinanceLiquidationMessage(payload: any): LiquidationEvent[] {
  const data = payload?.data ?? payload;
  if (data?.e !== "forceOrder" || !data?.o) return [];
  const order = data.o;
  const symbol = String(order.s ?? "").toUpperCase();
  const size = Number(order.q ?? order.z ?? 0);
  const avgPrice = Number(order.ap ?? 0);
  const orderPrice = Number(order.p ?? 0);
  const price = avgPrice > 0 ? avgPrice : orderPrice;
  if (!symbol || !Number.isFinite(size) || !Number.isFinite(price) || size <= 0 || price <= 0) return [];
  return [{
    exchange: "binance",
    symbol,
    timestamp: Number(order.T ?? data.E ?? Date.now()),
    side: String(order.S).toUpperCase() === "SELL" ? "LONG" : "SHORT",
    price,
    size,
    notionalUsd: price * size,
  }];
}

export function parseBybitLiquidationMessage(payload: any): LiquidationEvent[] {
  if (typeof payload?.topic !== "string" || !payload.topic.startsWith("allLiquidation.")) return [];
  const rows = Array.isArray(payload?.data) ? payload.data : payload?.data ? [payload.data] : [];
  return rows.flatMap((row: any) => {
    const symbol = String(row?.s ?? "").toUpperCase();
    const size = Number(row?.v);
    const price = Number(row?.p);
    if (!symbol || !Number.isFinite(size) || !Number.isFinite(price) || size <= 0 || price <= 0) return [];
    return [{
      exchange: "bybit" as const,
      symbol,
      timestamp: Number(row?.T ?? payload?.ts ?? Date.now()),
      // Bybit documents Buy as a liquidated long position, Sell as a liquidated short.
      side: String(row?.S).toUpperCase() === "BUY" ? "LONG" as const : "SHORT" as const,
      price,
      size,
      notionalUsd: price * size,
    }];
  });
}

export function normalizeHyperliquidCoin(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  if (upper.endsWith("USDT") && upper.length > 4) return upper.slice(0, -4);
  if (upper.endsWith("USD") && upper.length > 3) return upper.slice(0, -3);
  return upper;
}

async function getJson(fetchImpl: FetchLike, url: URL, label: string): Promise<any> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`${label} failed: ${response.status}`);
  return response.json();
}

async function postJson(fetchImpl: FetchLike, url: string, body: unknown, label: string): Promise<any> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${label} failed: ${response.status}`);
  return response.json();
}

function assertBybitOk(body: any, label: string): void {
  if (body?.retCode !== 0) throw new Error(`Bybit ${label} error: ${body?.retMsg ?? "invalid response"}`);
}

function latestTimestamp(...values: unknown[]): number {
  const timestamps = values.map(Number).filter((value) => Number.isFinite(value) && value > 0);
  return timestamps.length > 0 ? Math.max(...timestamps) : Date.now();
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampDepth(value: number, allowed: number[]): number {
  const requested = Math.max(1, Math.floor(value));
  return allowed.reduce((best, candidate) =>
    Math.abs(candidate - requested) < Math.abs(best - requested) ? candidate : best
  , allowed[0]);
}
