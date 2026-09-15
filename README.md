# Quant Swarm

**AI Quant Research Platform** — multi-agent hypothesis generation, deterministic market scanning/backtesting, statistical validation, and an AI-independent risk layer.

## Architecture

```text
Exchange REST/WebSocket
        ↓
Normalized Market Data + Market Intelligence
        ↓
Deterministic Candle / Microstructure Scanners
        ↓
Candidate Event
        ↓
AI Research Orchestrator
        ↓
Strategy DSL (validated JSON)
        ↓
Deterministic Backtester
        ↓
Baseline + Research-Grade Statistical Validation
        ↓
Independent Risk Engine
        ↓
Shadow / Paper / Live
```

### Core principles

- **LLM never computes performance** — indicators, market-intelligence metrics, backtests, and validation are deterministic.
- **LLM never executes orders** — no direct broker/exchange access from research agents.
- **No bot grades its own output** — research, backtest, validation, and risk are separated.
- **Risk engine is sovereign** — AI cannot bypass exposure limits or the kill switch.
- **Strategy DSL** — agents produce validated strategy JSON instead of arbitrary executable code.
- **Shadow first** — live trading is disabled by default.

## Project structure

```text
quant-swarm/
├─ apps/
│  └─ api/                    # Pipeline + observation-only live scanners
├─ packages/
│  ├─ shared/                 # Shared contracts + candidate-event types
│  ├─ strategy-schema/        # Zod strategy DSL
│  ├─ event-bus/              # Typed in-process event bus
│  ├─ market-data/            # Candle + market-intelligence providers
│  ├─ risk-contracts/         # AI-independent risk engine
│  └─ ai-orchestrator/        # Research-agent interface + mock agent
├─ services/
│  └─ quant-engine/
│     ├─ src/api/             # FastAPI scan/backtest/validate service
│     ├─ src/backtest/        # Deterministic execution simulator
│     ├─ src/indicators/      # Local indicators + rating approximation
│     ├─ src/scanners/        # Prior-window anomaly scanners
│     ├─ src/validation/      # Baseline + research-grade validation
│     └─ tests/
└─ .github/workflows/ci.yml
```

## Milestone 1 — complete

```text
Synthetic BTC OHLCV
→ Scanner
→ Mock Research Agent
→ Strategy DSL validation
→ Backtest
→ Baseline validation
→ Risk decision
→ SHADOW_APPROVED / SHADOW_REJECTED
```

The backtester uses next-bar-open execution for close-confirmed signals, intrabar high/low for stops and targets, conservative same-bar stop/target handling, mark-to-market equity, and net fees/slippage.

## Milestone 2 — live market-data foundation

Implemented candle providers:

- **Binance Spot** — REST `/api/v3/klines` + combined kline WebSocket streams.
- **Bybit V5** — REST `/v5/market/kline` + `kline.{interval}.{symbol}` public WebSocket topics.
- **Hyperliquid** — `candleSnapshot` info requests + `candle` WebSocket subscriptions.

All adapters normalize data into the same `MarketCandle` contract. Streaming uses reconnect with exponential backoff, best-effort REST backfill after reconnect, and timestamp deduplication so previously processed closed candles are not emitted twice.

`MultiSymbolLiveScanner` maintains bounded rolling buffers per exchange/symbol/timeframe and sends only newly closed candles through the deterministic Python anomaly scanner. The live candle scanner is **observation-only**: it never creates or sends orders.

## Milestone 3 — market intelligence layer

Milestone 3 adds a normalized derivatives/microstructure snapshot without putting an LLM in the calculation path.

Normalized fields include best bid/ask, midpoint/spread, quote-notional depth and imbalance, funding, open interest, mark/index-oracle basis, liquidation notional where a public feed exists, and source latency metadata.

Implemented public-data sources:

- **Binance USDⓈ-M Futures** — `/fapi/v1/depth`, `/fapi/v1/premiumIndex`, `/fapi/v1/openInterest`, plus `<symbol>@forceOrder` liquidation streams on the current futures market WebSocket route.
- **Bybit V5 linear/inverse** — `/v5/market/orderbook`, `/v5/market/tickers`, plus `allLiquidation.{symbol}` WebSocket topics. The default configuration is linear contracts.
- **Hyperliquid** — `l2Book` plus `metaAndAssetCtxs`; funding, open interest, mark price and oracle price are joined by asset index. No equivalent public market-wide liquidation feed is fabricated; those fields remain `null`.

`MarketIntelligenceScanner` deterministically emits `ORDERBOOK_IMBALANCE`, `FUNDING_EXTREME`, `OPEN_INTEREST_EXPANSION`, `BASIS_DISLOCATION`, `SPREAD_WIDENING`, `LIQUIDATION_SPIKE`, and rolling-return `VOLATILITY_EXPANSION` candidates with per exchange/symbol/type cooldowns.

## Milestone 4 — research-grade statistical validation

The original `/validate` endpoint remains the stable baseline gate. A new `/validate/research` endpoint adds research-process evidence that is required once the platform starts searching many strategies and parameter combinations.

Implemented deterministic controls:

- **Probabilistic Sharpe Ratio (PSR)** with finite-sample skew/kurtosis adjustment.
- **Deflated Sharpe Ratio (DSR)** using the observed distribution of trial Sharpes to raise the benchmark after multiple strategy searches.
- **Benjamini–Hochberg FDR** correction for candidate p-values.
- **CSCV / Probability of Backtest Overfitting (PBO)** from an observations × strategy-trials return matrix.
- **Purged + embargoed K-fold plans** for fixed-horizon time-series labels.
- **Regime robustness** from per-regime return series and the fraction of regimes with positive Sharpe.

Advanced evidence is intentionally not inferred from one winning backtest. If DSR/PBO/FDR/regime/CV evidence is missing, `/validate/research` reports the affected checks as `REVIEW`; it never converts missing evidence into a pass.

Example research-validation request:

```json
{
  "result": {
    "strategyId": "candidate-42",
    "totalTrades": 80,
    "sharpe": 1.6,
    "maxDrawdown": 8.0,
    "profitFactor": 1.5,
    "expectancy": 0.18,
    "equityCurve": [100000, 100120, 100090, 100240]
  },
  "evidence": {
    "annualization": 35040,
    "trialSharpes": [0.4, 0.7, 1.1, 1.6],
    "candidatePValues": [0.20, 0.08, 0.03, 0.004],
    "selectedTrialIndex": 3,
    "cscvReturns": [[0.001, 0.002], [-0.001, 0.001]],
    "regimeReturns": {
      "bull": [0.01, 0.005, -0.002],
      "bear": [0.002, -0.001, 0.003],
      "sideways": [0.001, 0.0, 0.002]
    },
    "purgedCv": {
      "nObservations": 1500,
      "nSplits": 5,
      "purgeBars": 4,
      "embargoBars": 4
    }
  }
}
```

The small matrices in documentation are schematic only; production DSR/PBO evidence should come from the full search ledger and out-of-sample return paths.

Methodology references include Bailey & López de Prado, *The Deflated Sharpe Ratio* (2014), and Bailey, Borwein, López de Prado & Zhu, *The Probability of Backtest Overfitting* (2017). The implementation is transparent and locally testable rather than delegating these calculations to an AI agent.

## Quick start

Requirements: Node.js 20+, pnpm 9+, Python 3.11+.

```bash
pnpm install
python -m pip install -e "services/quant-engine[dev]"
```

Start the deterministic quant engine:

```bash
pnpm run dev:engine
```

Run the synthetic pipeline:

```bash
pnpm run pipeline
```

Run the Milestone 2 live candle scanner:

```bash
MARKET_PROVIDER=binance \
MARKET_SUBSCRIPTIONS=BTCUSDT:15m,ETHUSDT:15m \
pnpm run live:scan
```

For Bybit candles:

```bash
MARKET_PROVIDER=bybit \
BYBIT_CATEGORY=linear \
MARKET_SUBSCRIPTIONS=BTCUSDT:15m,ETHUSDT:15m \
pnpm run live:scan
```

For Hyperliquid candles use native coin names:

```bash
MARKET_PROVIDER=hyperliquid \
MARKET_SUBSCRIPTIONS=BTC:15m,ETH:15m \
pnpm run live:scan
```

Run the Milestone 3 observation-only market-intelligence scanner:

```bash
INTELLIGENCE_PROVIDER=binance \
INTELLIGENCE_SYMBOLS=BTCUSDT,ETHUSDT \
pnpm run live:intelligence
```

For Bybit:

```bash
INTELLIGENCE_PROVIDER=bybit \
BYBIT_CATEGORY=linear \
INTELLIGENCE_SYMBOLS=BTCUSDT,ETHUSDT \
pnpm run live:intelligence
```

For Hyperliquid:

```bash
INTELLIGENCE_PROVIDER=hyperliquid \
INTELLIGENCE_SYMBOLS=BTC,ETH \
pnpm run live:intelligence
```

Run tests:

```bash
pnpm test
pnpm run test:py
```

## Safety defaults

`.env.example` starts with:

```text
TRADING_MODE=shadow
LIVE_TRADING_ENABLED=false
```

The market-data and market-intelligence adapters require no trading API keys. Execution APIs remain disabled. The risk engine supports explicit `reduceOnly` orders and a `KillSwitchStore` abstraction so production deployments can persist kill-switch state outside the process.

## Current limitations / next milestone

- Long-only backtester.
- Purged K-fold is currently bar-horizon based; event-time label-interval purging/CPCV path construction can be added when supervised ML labels enter the platform.
- Research evidence collection is not yet persisted in a strategy-search ledger; DSR/PBO/FDR inputs must currently be supplied to `/validate/research`.
- Milestone 3 intelligence thresholds are baseline development defaults and are not yet regime-adaptive.
- Order-book snapshots are polling-based; persistent local L2 books from snapshot+delta streams are a later optimization.
- Liquidation coverage is venue-specific; Hyperliquid public market-wide liquidation aggregation is intentionally unavailable in the current adapter.
- Kill-switch store defaults to in-memory; a durable production adapter is still required.
- No broker/exchange execution adapter is enabled.
- No OpenAI/Kimi production research adapter is enabled yet.

## License

All rights reserved.
