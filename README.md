# Quant Swarm

**AI Quant Research Platform** — TradingView-only market data, deterministic scanning/backtesting/statistics, bounded AI strategy research, an auditable research ledger, and an AI-independent risk layer.


### Price chart and trade markers

The dashboard loads closed TradingView candles for the selected market at **5m, 15m, 1h, 4h, or 1d**. Changing the chart timeframe refreshes the price series immediately; **Analyze <timeframe>** runs the one-off research pipeline for that exact market/timeframe.

Trade markers come from the append-only native trade ledger at `QUANT_TRADES_PATH` (default `.data/trades.jsonl`). `@quant-swarm/trade-ledger` provides:

- `PaperExecutor`: passes every proposed paper order through the sovereign `RiskEngine`, applies configurable adverse slippage/fees, then persists the fill.
- `JsonlTradeLedger`: idempotent append/list storage for paper and broker-recorded live fills.
- `brokerFill(...)`: validates and normalizes an already-executed broker fill. It does **not** place a live order.

Each JSONL row contains a normalized fill such as:

```json
{"schemaVersion":1,"id":"paper-001","symbol":"NASDAQ:AAPL","mode":"paper","side":"BUY","timestamp":1789990000000,"price":225.4,"quantity":10,"notional":2254,"fee":1.127,"strategyId":"aapl-example","source":"paper-executor"}
```

The dashboard never fabricates a live/real marker. A `mode:"live"` point appears only when a broker integration has recorded a validated broker fill in the ledger.

### Stateful paper portfolio

The native paper account reconstructs its state from the append-only fill ledger. `PaperPortfolio` tracks cash, average entry cost, open long quantities, realized/unrealized PnL, fees, peak equity, drawdown and gross/symbol exposure. `PaperExecutor.executeAgainstPortfolio(...)` derives the exact `PortfolioState` consumed by the sovereign risk engine before settling and persisting a fill.

The dashboard rebuilds this account using `PAPER_INITIAL_CASH` (default `100000`) and marks the currently selected symbol at its latest closed TradingView price. Other open symbols fall back to their average entry price until they are selected/marked by an integration.

A paper-only execution endpoint is available at `POST /api/paper/order`. It accepts an exchange-qualified symbol, `BUY`/`SELL`, positive quantity/price and optional `strategyId`. The request is risk-checked at the adverse simulated execution price, settled against a freshly reconstructed paper portfolio, then persisted with `PAPER_SLIPPAGE_BPS` and `PAPER_FEE_BPS`. Ledger-backed executions are serialized so concurrent requests cannot settle against the same stale cash balance. There is intentionally no equivalent live-order endpoint.

Daily-loss checks use a UTC-day baseline persisted at `PAPER_DAY_STATE_PATH` (default `.data/paper-day-state.json`) instead of treating lifetime PnL as daily PnL. The paper `RiskEngine` is also reused for the lifetime of the dashboard process so an activated drawdown kill switch is not forgotten on the next request.

### Holdout integrity

Every research run now fingerprints the complete split and the final holdout. Trial records carry dataset/holdout tags, and completed run records persist the dataset fingerprint, holdout fingerprint, split timestamp ranges, final-holdout metrics, annualization, and deterministic validation verdict/checks.

By default, a later run using the **identical already-consumed final holdout** is rejected. Set `RESEARCH_ALLOW_HOLDOUT_REUSE=true` only for an intentional controlled re-test. Universe research uses the configured durable research ledger; the JSONL backend is serialized to one asset at a time, while Postgres keeps multi-asset concurrency.

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
│  ├─ trade-ledger/             # Append-only fills + stateful paper portfolio
│  ├─ risk-contracts/           # AI-independent risk engine
│  └─ ai-orchestrator/          # Mock/OpenAI/Kimi research agents
├─ services/quant-engine/       # FastAPI scanner/backtester/stats/validation
└─ .github/workflows/ci.yml
```

## Strategy DSL indicator semantics

Multi-series indicators have explicit component semantics in new research hypotheses:

- `MACD`: `component` is `line`, `signal`, or `histogram`.
- `BBANDS`: `component` is `upper`, `middle`, or `lower`.
- `VWAP`: `source` is `close`, `hlc3`, or `ohlc4`; `reset` is `continuous` or `utc_day`.

The deterministic runner keeps legacy defaults for previously persisted strategies (`MACD=histogram`, `BBANDS=middle`, `VWAP source=close/reset=continuous`), while the AI research prompt requires new strategies to state these choices explicitly. Intraday VWAP hypotheses should normally use `reset=utc_day` unless cumulative behavior is intentionally being tested. Candle timestamps are passed into the runner and must be strictly increasing so session-reset indicators cannot silently use malformed time order.

## Statistical research

The quant engine includes PSR, DSR, Benjamini-Hochberg FDR, CSCV/PBO, real purged + embargoed K-fold test backtests, deterministic regime robustness, and separate validation/OOS and final-holdout stages. Each candidate strategy carries its own fold-level evidence; selection prefers purged-CV median Sharpe and positive-fold fraction before full-slice validation Sharpe.

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

The report is written to `.data/universe-report.json` by default. Universe ordering uses validation/OOS metrics only: validation Sharpe, then validation return, with deterministic symbol ordering as the final tiebreaker. Final holdout is post-selection evidence and never participates in ranking. **Positive holdout rate is not a probability of future profit.**

### Research dashboard

Start the dashboard after generating a report:

```bash
pnpm run dashboard
```

Open `http://127.0.0.1:4173`. The dashboard is a responsive **cartoon 3D Research Observatory** rather than a conventional finance admin panel. It combines the same deterministic evidence with a playful visual world:

- WebGL2 procedural aurora + starfield shader background with pointer parallax
- CSS 3D perspective/tilt cards, orbiting market planet and animated research objects
- container-query responsive composition plus mobile-specific layouts
- same-document View Transition enhancement when supported
- explicit reduced-motion support and CSS fallback when WebGL2 is unavailable
- assets researched, positive final-holdout rate, PASS count and average holdout return
- animated final-holdout “equity comet”
- PSR / DSR / PBO / FDR / regime “stat shield”
- keyboard-accessible filterable opportunity fleet
- strategy, candidate and selected-run details
- persistent Shadow Mode / TradingView-only source state

GPU effects are decorative only; research ordering and validation remain deterministic. The shader caps device pixel ratio and pauses when the page is hidden. If no real report exists yet, the dashboard deliberately shows a **Demo galaxy** badge and uses bundled visual sample data.

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
