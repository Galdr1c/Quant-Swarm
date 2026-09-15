import type { OHLCV } from "@quant-swarm/shared";
import type { MarketDataProvider } from "./index.js";

// ─── Configuration ────────────────────────────────────────────────────────────

export interface SyntheticConfig {
  /** Starting price (default: 60000 for BTC) */
  startPrice?: number;
  /** Annual drift / expected return (default: 0.0) */
  drift?: number;
  /** Annual volatility (default: 0.60 — roughly BTC-like) */
  volatility?: number;
  /** Base volume (default: 1000) */
  baseVolume?: number;
  /** Seed for reproducibility (default: 42) */
  seed?: number;
  /** Indices where anomalies should be injected (volume spikes + dislocations) */
  anomalyIndices?: number[];
  /**
   * Exclusive end/reference timestamp for the generated series.
   * Defaults to a fixed UTC instant so the same seed/config is fully reproducible.
   */
  endTimestamp?: number;
}

const DEFAULT_END_TIMESTAMP = Date.UTC(2026, 0, 1, 0, 0, 0, 0);

// ─── Seeded PRNG (Mulberry32) ─────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller transform for normal distribution from uniform */
function normalRandom(rng: () => number): number {
  let u1 = rng();
  let u2 = rng();
  while (u1 === 0) u1 = rng();
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

// ─── Synthetic Provider ───────────────────────────────────────────────────────

/**
 * Generates realistic synthetic OHLCV data using Geometric Brownian Motion.
 *
 * Key features:
 * - Seeded PRNG and deterministic timestamps for full reproducibility
 * - Configurable volatility/drift
 * - Anomaly injection at specified indices (for scanner testing)
 * - Realistic intra-candle high/low generation
 * - Volume with time-of-day seasonality
 */
export class SyntheticMarketDataProvider implements MarketDataProvider {
  readonly name = "synthetic";
  private config: Required<SyntheticConfig>;

  constructor(config: SyntheticConfig = {}) {
    this.config = {
      startPrice: config.startPrice ?? 60000,
      drift: config.drift ?? 0.0,
      volatility: config.volatility ?? 0.6,
      baseVolume: config.baseVolume ?? 1000,
      seed: config.seed ?? 42,
      anomalyIndices: config.anomalyIndices ?? [],
      endTimestamp: config.endTimestamp ?? DEFAULT_END_TIMESTAMP,
    };
  }

  async getHistoricalOHLCV(
    symbol: string,
    timeframe: string,
    limit: number
  ): Promise<OHLCV[]> {
    const rng = mulberry32(this.config.seed);
    const candles: OHLCV[] = [];

    const candleMinutes = this.parseTimeframe(timeframe);
    const candleMs = candleMinutes * 60 * 1000;
    const candlesPerYear = (365.25 * 24 * 60) / candleMinutes;
    const dt = 1 / candlesPerYear;
    const driftPerCandle = this.config.drift * dt;
    const volPerCandle = this.config.volatility * Math.sqrt(dt);

    let price = this.config.startPrice;
    const anomalySet = new Set(this.config.anomalyIndices);

    // The final generated candle starts one interval before endTimestamp.
    let timestamp = this.config.endTimestamp - limit * candleMs;

    for (let i = 0; i < limit; i++) {
      const isAnomaly = anomalySet.has(i);

      const z = normalRandom(rng);
      const returnVal = driftPerCandle + volPerCandle * z;

      const anomalyMultiplier = isAnomaly ? (rng() > 0.5 ? 3.5 : -3.5) : 1;
      const adjustedReturn = isAnomaly
        ? returnVal * anomalyMultiplier
        : returnVal;

      const open = price;
      const close = open * Math.exp(adjustedReturn);

      const range = Math.abs(close - open);
      const extraHigh = range * (0.1 + rng() * 0.5);
      const extraLow = range * (0.1 + rng() * 0.5);
      const high = Math.max(open, close) + extraHigh;
      const low = Math.min(open, close) - extraLow;

      const hourOfDay = ((i * candleMinutes) / 60) % 24;
      const seasonality =
        1 + 0.3 * Math.sin((2 * Math.PI * (hourOfDay - 14)) / 24);
      const volumeNoise = 0.5 + rng() * 1.0;
      const anomalyVolumeMultiplier = isAnomaly ? 5 + rng() * 10 : 1;
      const volume =
        this.config.baseVolume *
        seasonality *
        volumeNoise *
        anomalyVolumeMultiplier;

      candles.push({
        timestamp,
        open: round6(open),
        high: round6(high),
        low: round6(low),
        close: round6(close),
        volume: round6(volume),
      });

      price = close;
      timestamp += candleMs;
    }

    return candles;
  }

  private parseTimeframe(tf: string): number {
    const match = tf.match(/^(\d+)(m|h|d|w)$/);
    if (!match) return 15;

    const value = parseInt(match[1], 10);
    switch (match[2]) {
      case "m":
        return value;
      case "h":
        return value * 60;
      case "d":
        return value * 1440;
      case "w":
        return value * 10080;
      default:
        return 15;
    }
  }
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
