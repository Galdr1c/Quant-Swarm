import type { CandidateEvent, OHLCV } from "@quant-swarm/shared";
import type {
  CandleStream,
  CandleSubscription,
  MarketCandle,
  StreamingMarketDataProvider,
} from "@quant-swarm/market-data";

export interface ScannerClient {
  scan(symbol: string, candles: OHLCV[], zThreshold: number, lookbackWindow: number): Promise<CandidateEvent[]>;
}

export interface MultiSymbolScannerOptions {
  bufferSize?: number;
  zThreshold?: number;
  lookbackWindow?: number;
  onCandidate?: (event: CandidateEvent, candle: MarketCandle) => void | Promise<void>;
}

export class MultiSymbolLiveScanner {
  private readonly buffers = new Map<string, OHLCV[]>();
  private readonly latestClosedTimestamp = new Map<string, number>();
  private stream?: CandleStream;
  private readonly bufferSize: number;
  private readonly zThreshold: number;
  private readonly lookbackWindow: number;
  private readonly onCandidate?: (event: CandidateEvent, candle: MarketCandle) => void | Promise<void>;

  constructor(
    private readonly provider: StreamingMarketDataProvider,
    private readonly scannerClient: ScannerClient,
    options: MultiSymbolScannerOptions = {}
  ) {
    this.bufferSize = options.bufferSize ?? 500;
    this.zThreshold = options.zThreshold ?? 3;
    this.lookbackWindow = options.lookbackWindow ?? 100;
    this.onCandidate = options.onCandidate;
  }

  async start(subscriptions: CandleSubscription[]): Promise<void> {
    if (this.stream) throw new Error("Live scanner already started");

    for (const sub of subscriptions) {
      const history = await this.provider.getHistoricalOHLCV(
        sub.symbol,
        sub.timeframe,
        this.bufferSize
      );
      const key = this.key(this.provider.name, sub.symbol, sub.timeframe);
      const buffer = history.slice(-this.bufferSize);
      this.buffers.set(key, buffer);
      const last = buffer.at(-1);
      if (last) this.latestClosedTimestamp.set(key, last.timestamp);
    }

    this.stream = this.provider.subscribeCandles(subscriptions, async (candle) => {
      if (!candle.closed) return;
      await this.onClosedCandle(candle);
    });
  }

  stop(): void {
    this.stream?.close();
    this.stream = undefined;
  }

  getBuffer(exchange: string, symbol: string, timeframe: string): readonly OHLCV[] {
    return this.buffers.get(this.key(exchange, symbol, timeframe)) ?? [];
  }

  private async onClosedCandle(candle: MarketCandle): Promise<void> {
    const key = this.key(candle.exchange, candle.symbol, candle.timeframe);
    const lastSeen = this.latestClosedTimestamp.get(key);
    if (lastSeen !== undefined && candle.timestamp <= lastSeen) return;

    const buffer = [...(this.buffers.get(key) ?? [])];
    const plain: OHLCV = {
      timestamp: candle.timestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    };

    buffer.push(plain);
    buffer.sort((a, b) => a.timestamp - b.timestamp);
    this.buffers.set(key, buffer.slice(-this.bufferSize));
    this.latestClosedTimestamp.set(key, candle.timestamp);

    const current = this.buffers.get(key)!;
    if (current.length < this.lookbackWindow + 1) return;

    const events = await this.scannerClient.scan(
      candle.symbol,
      [...current],
      this.zThreshold,
      this.lookbackWindow
    );

    for (const event of events.filter((e) => e.timestamp === candle.timestamp)) {
      await this.onCandidate?.(event, candle);
    }
  }

  private key(exchange: string, symbol: string, timeframe: string): string {
    return `${exchange}:${symbol.toUpperCase()}:${timeframe}`;
  }
}

export class HttpScannerClient implements ScannerClient {
  constructor(private readonly engineUrl = "http://localhost:8420") {}

  async scan(symbol: string, candles: OHLCV[], zThreshold: number, lookbackWindow: number): Promise<CandidateEvent[]> {
    const response = await fetch(`${this.engineUrl}/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol, candles, zThreshold, lookbackWindow }),
    });
    if (!response.ok) throw new Error(`Quant scanner failed: ${response.status}`);
    const body = (await response.json()) as { events: CandidateEvent[] };
    return body.events;
  }
}
