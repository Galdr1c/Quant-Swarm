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
Statistical Validator
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
│     ├─ src/validation/      # Baseline deterministic validation gates
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

Normalized fields include:

- best bid/ask, midpoint and spread in basis points
- bid/ask depth in quote notional and order-book imbalance
- funding rate and next funding time when the venue exposes it
- open interest and estimated/open-interest quote value
- mark price, index/oracle price and mark-index basis in basis points
- rolling long/short liquidation notional where a public market-wide feed exists
- source timestamp/latency metadata

Implemented public-data sources:

- **Binance USDⓈ-M Futures** — `/fapi/v1/depth`, `/fapi/v1/premiumIndex`, `/fapi/v1/openInterest`, plus `<symbol>@forceOrder` liquidation streams on the current futures market WebSocket route.
- **Bybit V5 linear/inverse** — `/v5/market/orderbook`, `/v5/market/tickers`, plus `allLiquidation.{symbol}` WebSocket topics. The default configuration is linear contracts.
- **Hyperliquid** — `l2Book` plus `metaAndAssetCtxs`; funding, open interest, mark price and oracle price are joined by asset index. Hyperliquid does not currently expose an equivalent public market-wide liquidation stream through this adapter, so liquidation fields remain `null` rather than being fabricated.

`MarketIntelligenceScanner` keeps a bounded rolling history and deterministically emits the following `CandidateEvent` types:

- `ORDERBOOK_IMBALANCE`
- `FUNDING_EXTREME`
- `OPEN_INTEREST_EXPANSION`
- `BASIS_DISLOCATION`
- `SPREAD_WIDENING`
- `LIQUIDATION_SPIKE`
- `VOLATILITY_EXPANSION` from rolling midpoint log returns

Candidate cooldown prevents the same exchange/symbol/event type from being repeatedly emitted on every poll. Thresholds are environment-configurable and should be calibrated per venue, instrument and polling frequency; the defaults are development baselines, not trading recommendations.

The intelligence CLI uses only public market-data endpoints. It does not use API trading credentials and does not place orders.

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

Run the synthetic Milestone 1 pipeline:

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
- Baseline statistical validator only; walk-forward, purged/embargoed CV, Deflated Sharpe, multiple-testing correction, and regime robustness are still pending.
- Milestone 3 intelligence thresholds are baseline development defaults and are not yet regime-adaptive.
- Order-book snapshots are polling-based in Milestone 3; persistent local L2 books from snapshot+delta streams are a later optimization.
- Liquidation coverage is venue-specific; Hyperliquid public market-wide liquidation aggregation is intentionally unavailable in the current adapter.
- Kill-switch store defaults to in-memory; a durable production adapter is still required.
- No broker/exchange execution adapter is enabled.
- No OpenAI/Kimi production research adapter is enabled yet.

## License

All rights reserved.
