import { describe, expect, it, vi } from "vitest";
import {
  TradingViewMarketDataProvider,
  normalizeTradingViewPeriods,
  normalizeTradingViewSymbol,
  toTradingViewTimeframe,
  type TradingViewChartLike,
  type TradingViewClientFactory,
  type TradingViewPricePeriod,
} from "../src/tradingview.js";

class FakeChart implements TradingViewChartLike {
  periods: TradingViewPricePeriod[] = [];
  symbol?: string;
  marketOptions?: Record<string, unknown>;
  deleted = false;
  private readonly updates: ((...args: unknown[]) => void)[] = [];
  private readonly errors: ((...args: unknown[]) => void)[] = [];

  constructor(private readonly initialPeriods: TradingViewPricePeriod[]) {}

  setMarket(symbol: string, options: Record<string, unknown> = {}): void {
    this.symbol = symbol;
    this.marketOptions = options;
    this.periods = [...this.initialPeriods];
    queueMicrotask(() => this.emitUpdate());
  }

  onUpdate(callback: (...args: unknown[]) => void): void {
    this.updates.push(callback);
  }

  onError(callback: (...args: unknown[]) => void): void {
    this.errors.push(callback);
  }

  delete(): void {
    this.deleted = true;
  }

  emit(periods: TradingViewPricePeriod[]): void {
    this.periods = [...periods];
    this.emitUpdate();
  }

  private emitUpdate(): void {
    for (const callback of this.updates) callback();
  }
}

function period(time: number, close: number): TradingViewPricePeriod {
  return {
    time,
    open: close - 1,
    max: close + 2,
    min: close - 2,
    close,
    volume: 100 + close,
  };
}

function createFactory(initialPeriods: TradingViewPricePeriod[]) {
  const charts: FakeChart[] = [];
  const clients: { end: ReturnType<typeof vi.fn>; disconnect?: () => void }[] = [];

  const factory: TradingViewClientFactory = () => {
    const state: { end: ReturnType<typeof vi.fn>; disconnect?: () => void } = {
      end: vi.fn(async () => undefined),
    };
    clients.push(state);

    class Chart extends FakeChart {
      constructor() {
        super(initialPeriods);
        charts.push(this);
      }
    }

    return {
      Session: { Chart },
      end: state.end,
      onDisconnected(callback) {
        state.disconnect = callback;
      },
    };
  };

  return { factory, charts, clients };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("TradingView adapter", () => {
  it("maps Quant-Swarm timeframes to TradingView resolutions", () => {
    expect(toTradingViewTimeframe("15m")).toBe("15");
    expect(toTradingViewTimeframe("1h")).toBe("60");
    expect(toTradingViewTimeframe("4h")).toBe("240");
    expect(toTradingViewTimeframe("1d")).toBe("D");
    expect(toTradingViewTimeframe("1w")).toBe("W");
    expect(toTradingViewTimeframe("1M")).toBe("M");
  });

  it("requires exchange-qualified universal symbols", () => {
    expect(normalizeTradingViewSymbol("nasdaq:aapl")).toBe("NASDAQ:AAPL");
    expect(() => normalizeTradingViewSymbol("AAPL")).toThrow(/exchange-qualified/);
  });

  it("normalizes TradingView periods into ascending OHLCV rows", () => {
    const rows = normalizeTradingViewPeriods([period(300, 30), period(100, 10), period(200, 20)]);
    expect(rows.map((row) => row.timestamp)).toEqual([100_000, 200_000, 300_000]);
    expect(rows[0]).toMatchObject({ open: 9, high: 12, low: 8, close: 10, volume: 110 });
  });

  it("loads historical data and conservatively drops the current bar", async () => {
    const fake = createFactory([
      period(400, 40),
      period(300, 30),
      period(200, 20),
      period(100, 10),
    ]);
    const provider = new TradingViewMarketDataProvider({
      clientFactory: fake.factory,
      settleMs: 5,
      requestTimeoutMs: 1_000,
    });

    const rows = await provider.getHistoricalOHLCV("NASDAQ:AAPL", "15m", 3);

    expect(rows.map((row) => row.timestamp)).toEqual([100_000, 200_000, 300_000]);
    expect(fake.charts[0].symbol).toBe("NASDAQ:AAPL");
    expect(fake.charts[0].marketOptions).toMatchObject({ timeframe: "15", range: 4 });
    expect(fake.charts[0].deleted).toBe(true);
    expect(fake.clients[0].end).toHaveBeenCalledOnce();
  });

  it("emits only closed candles and deduplicates rollover updates", async () => {
    const fake = createFactory([
      period(300, 30),
      period(200, 20),
      period(100, 10),
    ]);
    const provider = new TradingViewMarketDataProvider({ clientFactory: fake.factory });
    const received: number[] = [];

    const stream = provider.subscribeCandles(
      [{ symbol: "BINANCE:BTCUSDT", timeframe: "1m" }],
      (candle) => {
        expect(candle.closed).toBe(true);
        expect(candle.exchange).toBe("tradingview");
        received.push(candle.timestamp);
      },
      { backfillLimit: 5 }
    );

    await flush();
    expect(received).toEqual([100_000, 200_000]);

    fake.charts[0].emit([
      period(400, 40),
      period(300, 30),
      period(200, 20),
    ]);
    await flush();
    expect(received).toEqual([100_000, 200_000, 300_000]);

    fake.charts[0].emit([
      period(400, 41),
      period(300, 30),
      period(200, 20),
    ]);
    await flush();
    expect(received).toEqual([100_000, 200_000, 300_000]);

    stream.close();
    expect(stream.closed).toBe(true);
    expect(fake.charts[0].deleted).toBe(true);
  });
});
