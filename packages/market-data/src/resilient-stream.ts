import type {
  CandleHandler,
  CandleStream,
  CandleStreamOptions,
  CandleSubscription,
  MarketCandle,
  WebSocketFactory,
  WebSocketLike,
} from "./types.js";

export interface ResilientStreamAdapter {
  buildUrl(subscriptions: CandleSubscription[]): string;
  onOpen?(socket: WebSocketLike, subscriptions: CandleSubscription[]): void;
  parseMessage(data: unknown): MarketCandle[];
  backfill(subscription: CandleSubscription, limit: number): Promise<MarketCandle[]>;
}

const OPEN = 1;

export function createDefaultWebSocketFactory(): WebSocketFactory {
  return (url: string) => {
    const Ctor = (globalThis as any).WebSocket;
    if (!Ctor) {
      throw new Error("Global WebSocket is unavailable. Use Node 20.10+ or inject a WebSocketFactory.");
    }
    return new Ctor(url) as WebSocketLike;
  };
}

export class ResilientCandleStream implements CandleStream {
  private socket?: WebSocketLike;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;
  private manuallyClosed = false;
  private lastClosedTimestamp = new Map<string, number>();

  constructor(
    private readonly adapter: ResilientStreamAdapter,
    private readonly subscriptions: CandleSubscription[],
    private readonly handler: CandleHandler,
    private readonly socketFactory: WebSocketFactory,
    private readonly options: Required<CandleStreamOptions>
  ) {
    if (subscriptions.length === 0) {
      throw new Error("At least one candle subscription is required");
    }
    this.connect();
  }

  get closed(): boolean {
    return this.manuallyClosed;
  }

  close(): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }

  private connect(): void {
    if (this.manuallyClosed) return;

    const socket = this.socketFactory(this.adapter.buildUrl(this.subscriptions));
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      this.adapter.onOpen?.(socket, this.subscriptions);
      void this.backfillMissing();
    });

    socket.addEventListener("message", (event: any) => {
      let raw: unknown = event?.data ?? event;
      if (typeof raw === "string") {
        try {
          raw = JSON.parse(raw);
        } catch {
          return;
        }
      }
      for (const candle of this.adapter.parseMessage(raw)) {
        void this.emit(candle);
      }
    });

    socket.addEventListener("close", () => {
      if (!this.manuallyClosed) this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      if (!this.manuallyClosed && socket.readyState === OPEN) socket.close();
    });
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      this.options.reconnectMaxMs,
      this.options.reconnectBaseMs * 2 ** this.reconnectAttempt
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private async backfillMissing(): Promise<void> {
    for (const subscription of this.subscriptions) {
      try {
        const candles = await this.adapter.backfill(subscription, this.options.backfillLimit);
        for (const candle of candles) {
          if (!candle.closed) continue;
          const key = this.key(candle);
          const last = this.lastClosedTimestamp.get(key) ?? -Infinity;
          if (candle.timestamp > last) await this.emit(candle);
        }
      } catch {
        // Backfill is best-effort. Live streaming remains active even if REST is unavailable.
      }
    }
  }

  private async emit(candle: MarketCandle): Promise<void> {
    if (candle.closed) {
      const key = this.key(candle);
      const last = this.lastClosedTimestamp.get(key) ?? -Infinity;
      if (candle.timestamp <= last) return;
      this.lastClosedTimestamp.set(key, candle.timestamp);
    }
    await this.handler(candle);
  }

  private key(candle: MarketCandle): string {
    return `${candle.exchange}:${candle.symbol}:${candle.timeframe}`;
  }
}

export function normalizeStreamOptions(options: CandleStreamOptions = {}): Required<CandleStreamOptions> {
  return {
    reconnectBaseMs: options.reconnectBaseMs ?? 1_000,
    reconnectMaxMs: options.reconnectMaxMs ?? 30_000,
    backfillLimit: options.backfillLimit ?? 5,
  };
}
