# Quant Swarm

**AI Quant Research Platform** — multi-agent hypothesis generation, deterministic market scanning/backtesting, statistical validation, and an AI-independent risk layer.

## Architecture

```text
Exchange REST/WebSocket
        ↓
Normalized Market Data
        ↓
Deterministic Multi-Symbol Scanner
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

- **LLM never computes performance** — indicators, backtests, and validation are deterministic.
- **LLM never executes orders** — no direct broker/exchange access from research agents.
- **No bot grades its own output** — research, backtest, validation, and risk are separated.
- **Risk engine is sovereign** — AI cannot bypass exposure limits or the kill switch.
- **Strategy DSL** — agents produce validated strategy JSON instead of arbitrary executable code.
- **Shadow first** — live trading is disabled by default.

## Project structure

```text
quant-swarm/
├─ apps/
│  └─ api/                    # Pipeline + observation-only live scanner
├─ packages/
│  ├─ shared/                 # Shared contracts
│  ├─ strategy-schema/        # Zod strategy DSL
│  ├─ event-bus/              # Typed in-process event bus
│  ├─ market-data/            # Synthetic + Binance + Bybit + Hyperliquid
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

Implemented market-data providers:

- **Binance Spot** — REST `/api/v3/klines` + combined kline WebSocket streams.
- **Bybit V5** — REST `/v5/market/kline` + `kline.{interval}.{symbol}` public WebSocket topics.
- **Hyperliquid** — `candleSnapshot` REST info requests + `candle` WebSocket subscriptions.

All adapters normalize data into the same `MarketCandle` contract. Streaming uses reconnect with exponential backoff, best-effort REST backfill after reconnect, and timestamp deduplication so previously processed closed candles are not emitted twice.

`MultiSymbolLiveScanner` maintains bounded rolling buffers per exchange/symbol/timeframe and sends only newly closed candles through the deterministic Python anomaly scanner. The live scanner is **observation-only**: it never creates or sends orders.

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

Run the live observation-only scanner:

```bash
MARKET_PROVIDER=binance \
MARKET_SUBSCRIPTIONS=BTCUSDT:15m,ETHUSDT:15m \
pnpm run live:scan
```

For Bybit:

```bash
MARKET_PROVIDER=bybit \
BYBIT_CATEGORY=linear \
MARKET_SUBSCRIPTIONS=BTCUSDT:15m,ETHUSDT:15m \
pnpm run live:scan
```

For Hyperliquid use native coin names:

```bash
MARKET_PROVIDER=hyperliquid \
MARKET_SUBSCRIPTIONS=BTC:15m,ETH:15m \
pnpm run live:scan
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

The market-data adapters require no trading API keys. Execution APIs remain disabled. The risk engine supports explicit `reduceOnly` orders and a `KillSwitchStore` abstraction so production deployments can persist kill-switch state outside the process.

## Current limitations / next milestone

- Long-only backtester.
- Baseline statistical validator only; walk-forward, purged/embargoed CV, Deflated Sharpe, multiple-testing correction, and regime robustness are still pending.
- Kill-switch store defaults to in-memory; a durable production adapter is still required.
- No broker/exchange execution adapter is enabled.
- No OpenAI/Kimi production research adapter is enabled yet.
- Live scanner currently processes candle-close data; order-book/funding/open-interest feeds are next.

## License

All rights reserved.
