# Quant Swarm

**AI Quant Research Platform** — TradingView-only market data, deterministic scanning/backtesting/statistics, bounded AI strategy research, an auditable research ledger, and an AI-independent risk layer.

## Architecture

```text
TradingView (@mathieuc/tradingview)
        ↓
Universal OHLCV
Crypto / Stocks / Forex / Indices / Commodities
        ↓
Deterministic Candle Scanner
        ↓
Candidate Event
        ↓
Bounded AI Research Orchestrator
        ↓
Strategy DSL (validated JSON)
        ↓
Validation/OOS Backtests → Transactional Research Ledger
        ↓                         ↓
Discovery-calibrated Regimes → Regime Return Evidence
        ↓
Selected Strategy → Separate Final Holdout
        ↓
Research-Grade Statistical Validation
        ↓
Independent Risk Engine
        ↓
Shadow / Paper / Live
```

## Market data

Quant-Swarm has **one external market-data integration: TradingView**, through `@mathieuc/tradingview` from Mathieu2301/TradingView-API.

Direct Binance, Bybit, Hyperliquid, order-book, funding, open-interest, and liquidation adapters have been removed.

Use TradingView-qualified symbols:

```text
BINANCE:BTCUSDT
NASDAQ:AAPL
OANDA:EURUSD
TVC:GOLD
```

The prefix is part of TradingView's symbol identifier. For example, `BINANCE:BTCUSDT` still travels through TradingView; Quant-Swarm does not call Binance's API.

The TradingView adapter handles historical OHLCV, live closed candles, reconnect/deduplication, timeframe normalization, symbol search, and incomplete-current-bar exclusion. Anonymous access is the default; TradingView session/signature values are optional.

CI includes a real anonymous TradingView smoke test for crypto and stock candles.

## Core principles

- LLMs generate strategy hypotheses only; they never calculate accepted performance.
- Backtests, statistics, regimes, and validation are deterministic.
- Strategy output must pass the local Strategy DSL validator.
- Research, validation, and risk are separate.
- Postgres research runs use leases, heartbeat renewal, stale reclaim, and fencing.
- Live trading is disabled by default.

## Project structure

```text
quant-swarm/
├─ apps/api/                    # TradingView live scanner + single/universe research executors
├─ apps/dashboard/              # Responsive research command center
├─ packages/
│  ├─ shared/                   # OHLCV + candidate contracts
│  ├─ strategy-schema/          # Strategy DSL
│  ├─ event-bus/                # Typed in-process event bus
│  ├─ market-data/              # TradingView provider + synthetic test fixture
│  ├─ research-ledger/          # JSONL/Postgres research persistence
│  ├─ risk-contracts/           # AI-independent risk engine
│  └─ ai-orchestrator/          # Mock/OpenAI/Kimi research agents
├─ services/quant-engine/       # FastAPI scanner/backtester/stats/validation
└─ .github/workflows/ci.yml
```

## Statistical research

The quant engine includes PSR, DSR, Benjamini-Hochberg FDR, CSCV/PBO, purged + embargoed K-fold planning, deterministic regime robustness, and separate validation/OOS and final-holdout stages.

```text
Discovery
  → candidate context + regime calibration

Validation/OOS
  → compare generated strategies
  → deterministic evidence + strategy selection

Final holdout
  → selected strategy only
  → research-grade validation
```

Missing advanced evidence remains `REVIEW`, never an automatic `PASS`.

## Quick start

Requirements: Node.js 20+, pnpm 9+, Python 3.11+.

```bash
pnpm install
python -m pip install -e "services/quant-engine[dev]"
pnpm run dev:engine
```

Run the TradingView live scanner:

```bash
MARKET_SUBSCRIPTIONS=BINANCE:BTCUSDT:15m,NASDAQ:AAPL:15m,OANDA:EURUSD:15m,TVC:GOLD:1h \
pnpm run live:scan
```

Run the real anonymous TradingView smoke:

```bash
pnpm run tradingview:smoke
```

Run deterministic single-market research without paid AI APIs:

```bash
RESEARCH_PROVIDERS=mock,mock,mock pnpm run research:run
```

## Multi-asset universe research

Research a TradingView universe across crypto, stocks, forex and commodities:

```bash
RESEARCH_PROVIDERS=mock,mock,mock \
UNIVERSE_SUBSCRIPTIONS=BINANCE:BTCUSDT:4h,NASDAQ:NVDA:1h,OANDA:EURUSD:1h,TVC:GOLD:4h \
pnpm run research:universe
```

For each asset Quant-Swarm:

```text
TradingView history
→ 60% discovery / regime calibration
→ deterministic candidate scan
→ multi-agent Strategy DSL hypotheses
→ 20% validation/OOS comparison
→ selected strategy
→ untouched 20% final holdout
→ PSR / DSR / FDR / PBO / regime validation
→ ranked universe report
```

The report is written to `.data/universe-report.json` by default. Ranking is evidence-first: validation verdict, then final-holdout Sharpe, then final-holdout return. **Positive holdout rate is not a probability of future profit.**

### Research dashboard

Start the dashboard after generating a report:

```bash
pnpm run dashboard
```

Open `http://127.0.0.1:4173`. The responsive dashboard shows:

- assets researched, positive final-holdout rate, PASS count and average holdout return
- top final-holdout equity curve
- PSR / DSR / PBO / FDR / regime validation matrix
- filterable opportunity table
- strategy, candidate and selected-run details
- persistent Shadow Mode / TradingView-only data-source status

If no real report exists yet, the dashboard deliberately shows a **Demo data** badge and uses a bundled visual sample.

Run tests:

```bash
pnpm test
pnpm run test:py
```

## Durable research ledger

```bash
RESEARCH_LEDGER_BACKEND=postgres \
DATABASE_URL=postgresql://quant_swarm:password@localhost:5432/quant_swarm \
RESEARCH_POSTGRES_SCHEMA=quant_swarm \
RESEARCH_WORKER_ID=quant-worker-01 \
RESEARCH_PROVIDERS=mock,mock,mock \
pnpm run research:run
```

## Safety defaults

```text
TRADING_MODE=shadow
LIVE_TRADING_ENABLED=false
```

No broker/exchange execution adapter is enabled.

## Current limitations

- Long-only backtester.
- Purged K-fold remains bar-horizon based.
- Regime calibration drift monitoring is not implemented.
- Database migrations remain application-managed.
- Agent fan-out is fixed rather than adaptive.
- Kill-switch storage defaults to in-memory.
- TradingView access uses a community client rather than an official production market-data contract.
- No real-money execution adapter is enabled.

## License

All rights reserved.
