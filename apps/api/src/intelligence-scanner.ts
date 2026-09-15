import type { CandidateEvent } from "@quant-swarm/shared";
import type {
  IntelligenceStream,
  MarketIntelligenceProvider,
  MarketIntelligenceSnapshot,
} from "@quant-swarm/market-data";

export interface MarketIntelligenceScannerOptions {
  pollIntervalMs?: number;
  historySize?: number;
  orderBookImbalanceThreshold?: number;
  fundingRateThreshold?: number;
  openInterestChangePctThreshold?: number;
  openInterestLookbackSamples?: number;
  basisBpsThreshold?: number;
  spreadBpsThreshold?: number;
  liquidationUsdThreshold?: number;
  volatilityBpsThreshold?: number;
  volatilityLookbackSamples?: number;
  candidateCooldownMs?: number;
  onSnapshot?: (snapshot: MarketIntelligenceSnapshot) => void | Promise<void>;
  onCandidate?: (event: CandidateEvent, snapshot: MarketIntelligenceSnapshot) => void | Promise<void>;
  onError?: (symbol: string, error: unknown) => void | Promise<void>;
}

export interface IntelligenceSampleResult {
  snapshot: MarketIntelligenceSnapshot;
  events: CandidateEvent[];
}

export class MarketIntelligenceScanner {
  private readonly history = new Map<string, MarketIntelligenceSnapshot[]>();
  private readonly lastEmission = new Map<string, number>();
  private pollTimer?: ReturnType<typeof setInterval>;
  private liquidationStream?: IntelligenceStream;
  private polling = false;

  private readonly pollIntervalMs: number;
  private readonly historySize: number;
  private readonly imbalanceThreshold: number;
  private readonly fundingThreshold: number;
  private readonly oiThresholdPct: number;
  private readonly oiLookbackSamples: number;
  private readonly basisThresholdBps: number;
  private readonly spreadThresholdBps: number;
  private readonly liquidationThresholdUsd: number;
  private readonly volatilityThresholdBps: number;
  private readonly volatilityLookbackSamples: number;
  private readonly cooldownMs: number;

  constructor(
    private readonly provider: MarketIntelligenceProvider,
    private readonly options: MarketIntelligenceScannerOptions = {}
  ) {
    this.pollIntervalMs = positive(options.pollIntervalMs, 5_000);
    this.historySize = Math.max(3, Math.floor(positive(options.historySize, 120)));
    this.imbalanceThreshold = Math.min(0.99, Math.max(0, options.orderBookImbalanceThreshold ?? 0.35));
    this.fundingThreshold = Math.max(0, options.fundingRateThreshold ?? 0.0005);
    this.oiThresholdPct = Math.max(0, options.openInterestChangePctThreshold ?? 2);
    this.oiLookbackSamples = Math.max(1, Math.floor(positive(options.openInterestLookbackSamples, 12)));
    this.basisThresholdBps = Math.max(0, options.basisBpsThreshold ?? 10);
    this.spreadThresholdBps = Math.max(0, options.spreadBpsThreshold ?? 5);
    this.liquidationThresholdUsd = Math.max(0, options.liquidationUsdThreshold ?? 1_000_000);
    this.volatilityThresholdBps = Math.max(0, options.volatilityBpsThreshold ?? 25);
    this.volatilityLookbackSamples = Math.max(3, Math.floor(positive(options.volatilityLookbackSamples, 20)));
    this.cooldownMs = Math.max(0, options.candidateCooldownMs ?? 60_000);
  }

  async start(symbols: string[]): Promise<void> {
    if (this.pollTimer) throw new Error("Market intelligence scanner already started");
    const normalized = uniqueSymbols(symbols);
    if (normalized.length === 0) throw new Error("At least one intelligence symbol is required");

    this.liquidationStream = this.provider.subscribeLiquidations?.(normalized);
    await this.pollAll(normalized);
    this.pollTimer = setInterval(() => {
      void this.pollAll(normalized);
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.liquidationStream?.close();
    this.liquidationStream = undefined;
  }

  async sample(symbol: string): Promise<IntelligenceSampleResult> {
    const snapshot = await this.provider.getSnapshot(symbol);
    await this.options.onSnapshot?.(snapshot);
    const events = this.scanSnapshot(snapshot);
    for (const event of events) await this.options.onCandidate?.(event, snapshot);
    return { snapshot, events };
  }

  scanSnapshot(snapshot: MarketIntelligenceSnapshot): CandidateEvent[] {
    const key = this.key(snapshot.exchange, snapshot.symbol);
    const rows = [...(this.history.get(key) ?? []), snapshot]
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-this.historySize);
    this.history.set(key, rows);

    const candidates: CandidateEvent[] = [];
    const imbalance = snapshot.orderBookImbalance;
    if (Math.abs(imbalance) >= this.imbalanceThreshold && this.imbalanceThreshold > 0) {
      candidates.push(this.event(snapshot, "ORDERBOOK_IMBALANCE", Math.abs(imbalance) / this.imbalanceThreshold, {
        orderbook_imbalance: imbalance,
        direction: Math.sign(imbalance),
        bid_depth_usd: snapshot.bidDepthUsd,
        ask_depth_usd: snapshot.askDepthUsd,
      }));
    }

    if (snapshot.fundingRate !== null && Math.abs(snapshot.fundingRate) >= this.fundingThreshold && this.fundingThreshold > 0) {
      candidates.push(this.event(snapshot, "FUNDING_EXTREME", Math.abs(snapshot.fundingRate) / this.fundingThreshold, {
        funding_rate: snapshot.fundingRate,
        direction: Math.sign(snapshot.fundingRate),
      }));
    }

    const oiChangePct = this.openInterestChangePct(rows);
    if (oiChangePct !== null && Math.abs(oiChangePct) >= this.oiThresholdPct && this.oiThresholdPct > 0) {
      candidates.push(this.event(snapshot, "OPEN_INTEREST_EXPANSION", Math.abs(oiChangePct) / this.oiThresholdPct, {
        open_interest_change_pct: oiChangePct,
        direction: Math.sign(oiChangePct),
        open_interest: snapshot.openInterest ?? 0,
        open_interest_usd: snapshot.openInterestUsd ?? 0,
      }));
    }

    if (snapshot.basisBps !== null && Math.abs(snapshot.basisBps) >= this.basisThresholdBps && this.basisThresholdBps > 0) {
      candidates.push(this.event(snapshot, "BASIS_DISLOCATION", Math.abs(snapshot.basisBps) / this.basisThresholdBps, {
        basis_bps: snapshot.basisBps,
        direction: Math.sign(snapshot.basisBps),
        mark_price: snapshot.markPrice ?? snapshot.midPrice,
        index_price: snapshot.indexPrice ?? snapshot.midPrice,
      }));
    }

    if (snapshot.spreadBps >= this.spreadThresholdBps && this.spreadThresholdBps > 0) {
      candidates.push(this.event(snapshot, "SPREAD_WIDENING", snapshot.spreadBps / this.spreadThresholdBps, {
        spread_bps: snapshot.spreadBps,
        best_bid: snapshot.bestBid,
        best_ask: snapshot.bestAsk,
      }));
    }

    const liquidationLong = snapshot.liquidationLongUsd;
    const liquidationShort = snapshot.liquidationShortUsd;
    if (liquidationLong !== null && liquidationShort !== null) {
      const liquidationTotal = liquidationLong + liquidationShort;
      if (liquidationTotal >= this.liquidationThresholdUsd && this.liquidationThresholdUsd > 0) {
        candidates.push(this.event(snapshot, "LIQUIDATION_SPIKE", liquidationTotal / this.liquidationThresholdUsd, {
          liquidation_total_usd: liquidationTotal,
          liquidation_long_usd: liquidationLong,
          liquidation_short_usd: liquidationShort,
          liquidation_imbalance: liquidationTotal > 0 ? (liquidationLong - liquidationShort) / liquidationTotal : 0,
        }));
      }
    }

    const volatilityBps = rollingVolatilityBps(rows, this.volatilityLookbackSamples);
    if (volatilityBps !== null && volatilityBps >= this.volatilityThresholdBps && this.volatilityThresholdBps > 0) {
      candidates.push(this.event(snapshot, "VOLATILITY_EXPANSION", volatilityBps / this.volatilityThresholdBps, {
        rolling_return_volatility_bps: volatilityBps,
        lookback_samples: Math.min(rows.length, this.volatilityLookbackSamples),
      }));
    }

    return candidates.filter((candidate) => this.withinCooldown(candidate, snapshot.exchange));
  }

  getHistory(exchange: string, symbol: string): readonly MarketIntelligenceSnapshot[] {
    return this.history.get(this.key(exchange, symbol)) ?? [];
  }

  private async pollAll(symbols: string[]): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const symbol of symbols) {
        try {
          await this.sample(symbol);
        } catch (error) {
          await this.options.onError?.(symbol, error);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private openInterestChangePct(rows: MarketIntelligenceSnapshot[]): number | null {
    const valid = rows.filter((row) => row.openInterest !== null && row.openInterest > 0);
    if (valid.length < 2) return null;
    const window = valid.slice(-(this.oiLookbackSamples + 1));
    const first = window[0].openInterest;
    const last = window.at(-1)!.openInterest;
    if (first === null || last === null || first === 0) return null;
    return ((last - first) / first) * 100;
  }

  private event(
    snapshot: MarketIntelligenceSnapshot,
    type: CandidateEvent["type"],
    score: number,
    metadata: Record<string, number>
  ): CandidateEvent {
    return {
      symbol: snapshot.symbol,
      type,
      score,
      timestamp: snapshot.timestamp,
      metadata,
    };
  }

  private withinCooldown(event: CandidateEvent, exchange: string): boolean {
    const key = `${exchange}:${event.symbol}:${event.type}`;
    const last = this.lastEmission.get(key);
    if (last !== undefined && event.timestamp - last < this.cooldownMs) return false;
    this.lastEmission.set(key, event.timestamp);
    return true;
  }

  private key(exchange: string, symbol: string): string {
    return `${exchange}:${symbol.toUpperCase()}`;
  }
}

export function rollingVolatilityBps(
  rows: MarketIntelligenceSnapshot[],
  lookbackSamples: number
): number | null {
  const window = rows.slice(-Math.max(3, lookbackSamples));
  if (window.length < 3) return null;
  const returns: number[] = [];
  for (let i = 1; i < window.length; i += 1) {
    const previous = window[i - 1].midPrice;
    const current = window[i].midPrice;
    if (previous <= 0 || current <= 0) continue;
    returns.push(Math.log(current / previous));
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(Math.max(0, variance)) * 10_000;
}

function uniqueSymbols(symbols: string[]): string[] {
  return [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? value as number : fallback;
}
