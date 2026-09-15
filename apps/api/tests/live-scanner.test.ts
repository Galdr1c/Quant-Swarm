import { describe, expect, it } from "vitest";
import type { OHLCV, CandidateEvent } from "@quant-swarm/shared";
import type {
  CandleHandler,
  CandleStream,
  CandleSubscription,
  StreamingMarketDataProvider,
} from "@quant-swarm/market-data";
import { MultiSymbolLiveScanner, type ScannerClient } from "../src/live-scanner.js";

class FakeStream implements CandleStream {
  closed = false;
  close(): void { this.closed = true; }
}

class FakeProvider implements StreamingMarketDataProvider {
  readonly name = "binance" as const;
  handler?: CandleHandler;

  async getHistoricalOHLCV(symbol: string, _timeframe: string, limit: number): Promise<OHLCV[]> {
    return Array.from({ length: limit }, (_, i) => ({
      timestamp: i * 60_000,
      open: 100 + i,
      high: 101 + i,
      low: 99 + i,
      close: 100 + i,
      volume: 10,
    }));
  }

  subscribeCandles(_subscriptions: CandleSubscription[], handler: CandleHandler): CandleStream {
    this.handler = handler;
    return new FakeStream();
  }
}

class FakeScannerClient implements ScannerClient {
  calls: Array<{ symbol: string; size: number }> = [];
  async scan(symbol: string, candles: OHLCV[]): Promise<CandidateEvent[]> {
    this.calls.push({ symbol, size: candles.length });
    const last = candles[candles.length - 1];
    return [{
      symbol,
      type: "VOLUME_ANOMALY",
      score: 4.2,
      timestamp: last.timestamp,
      metadata: { volumeZScore: 4.2 },
    }];
  }
}

describe("MultiSymbolLiveScanner", () => {
  it("backfills each symbol and scans only closed candles", async () => {
    const provider = new FakeProvider();
    const client = new FakeScannerClient();
    const candidates: CandidateEvent[] = [];
    const scanner = new MultiSymbolLiveScanner(provider, client, {
      bufferSize: 120,
      lookbackWindow: 100,
      onCandidate: (event) => { candidates.push(event); },
    });

    await scanner.start([
      { symbol: "BTCUSDT", timeframe: "15m" },
      { symbol: "ETHUSDT", timeframe: "15m" },
    ]);

    expect(scanner.getBuffer("binance", "BTCUSDT", "15m")).toHaveLength(120);
    expect(scanner.getBuffer("binance", "ETHUSDT", "15m")).toHaveLength(120);

    await provider.handler?.({
      exchange: "binance",
      symbol: "BTCUSDT",
      timeframe: "15m",
      timestamp: 120 * 60_000,
      open: 220,
      high: 230,
      low: 210,
      close: 225,
      volume: 999,
      closed: false,
    });
    expect(client.calls).toHaveLength(0);

    await provider.handler?.({
      exchange: "binance",
      symbol: "BTCUSDT",
      timeframe: "15m",
      timestamp: 120 * 60_000,
      open: 220,
      high: 230,
      low: 210,
      close: 225,
      volume: 999,
      closed: true,
    });

    expect(client.calls).toEqual([{ symbol: "BTCUSDT", size: 120 }]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].timestamp).toBe(120 * 60_000);
    scanner.stop();
  });
});
