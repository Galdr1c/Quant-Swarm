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

### Core principles

- **LLM never computes performance** — indicators, market-intelligence metrics, backtests, p-values, regime evidence, and validation are deterministic.
- **LLM never executes orders** — research agents have no broker/exchange execution authority.
- **No bot grades its own output** — research, backtest, validation, and risk are separated.
- **Risk engine is sovereign** — AI cannot bypass exposure limits or the kill switch.
- **Strategy DSL** — agents produce validated strategy JSON instead of arbitrary executable code.
- **Research history is auditable** — evaluated trials retain provider/model provenance, the exact validated Strategy DSL snapshot, a canonical SHA-256 fingerprint, and deterministic numeric evidence.
- **Run identity is protected** — Postgres workers use expiring leases plus generation/token fencing, so stale workers cannot write after a crash/reclaim.
- **Shadow first** — live trading is disabled by default.

## Project structure

```text
quant-swarm/
├─ apps/
│  └─ api/                    # Pipeline, live scanners, research-search executor
├─ packages/
│  ├─ shared/                 # Shared contracts + candidate-event types
│  ├─ strategy-schema/        # Zod strategy DSL
│  ├─ event-bus/              # Typed in-process event bus
│  ├─ market-data/            # Candle + market-intelligence providers
│  ├─ research-ledger/        # JSONL/Postgres run + trial ledger and evidence builder
│  ├─ risk-contracts/         # AI-independent risk engine
│  └─ ai-orchestrator/        # Mock/OpenAI/Kimi agents + bounded coordinator
├─ services/
│  └─ quant-engine/
│     ├─ src/api/             # FastAPI scan/backtest/stats/regime/validate service
│     ├─ src/backtest/        # Deterministic execution simulator
│     ├─ src/indicators/      # Local indicators + rating approximation
│     ├─ src/scanners/        # Prior-window anomaly scanners
│     ├─ src/validation/      # Baseline + research-grade + regime validation
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

Normalized fields include best bid/ask, midpoint/spread, quote-notional depth and imbalance, funding, open interest, mark/index-oracle basis, liquidation notional where the venue exposes a public feed, and source latency metadata.

Implemented public-data sources:

- **Binance USDⓈ-M Futures** — `/fapi/v1/depth`, `/fapi/v1/premiumIndex`, `/fapi/v1/openInterest`, plus `<symbol>@forceOrder` liquidation streams.
- **Bybit V5 linear/inverse** — `/v5/market/orderbook`, `/v5/market/tickers`, plus `allLiquidation.{symbol}` WebSocket topics.
- **Hyperliquid** — `l2Book` plus `metaAndAssetCtxs`; funding, open interest, mark price and oracle price are joined by asset index. No equivalent public market-wide liquidation feed is fabricated; those fields remain `null`.

`MarketIntelligenceScanner` deterministically emits `ORDERBOOK_IMBALANCE`, `FUNDING_EXTREME`, `OPEN_INTEREST_EXPANSION`, `BASIS_DISLOCATION`, `SPREAD_WIDENING`, `LIQUIDATION_SPIKE`, and rolling-return `VOLATILITY_EXPANSION` candidates with per exchange/symbol/type cooldowns.

## Milestone 4 — research-grade statistical validation

The original `/validate` endpoint remains the stable baseline gate. `/validate/research` adds research-process evidence required once the platform searches many strategies and parameter combinations.

Implemented deterministic controls:

- **Probabilistic Sharpe Ratio (PSR)** with finite-sample skew/kurtosis adjustment.
- **Deflated Sharpe Ratio (DSR)** using the observed distribution of trial Sharpes.
- **Benjamini–Hochberg FDR** correction for candidate p-values.
- **CSCV / Probability of Backtest Overfitting (PBO)** from an observations × strategy-trials return matrix.
- **Purged + embargoed K-fold plans** for fixed-horizon time-series labels.
- **Regime robustness** from per-regime return series and the fraction of regimes with positive Sharpe.

Missing DSR/PBO/FDR/regime/CV evidence is explicitly `REVIEW`; it is never silently promoted to `PASS`. The quant engine exposes `/stats/psr` so candidate p-values are computed from actual equity curves rather than generated by an AI agent.

Methodology references include Bailey & López de Prado, *The Deflated Sharpe Ratio* (2014), and Bailey, Borwein, López de Prado & Zhu, *The Probability of Backtest Overfitting* (2017).

## Milestone 5 — research ledger + production agent adapters

`@quant-swarm/ai-orchestrator` includes:

- `OpenAIResearchAgent` — GPT-6 Astra through the Responses API, Structured JSON output, configurable reasoning effort, and `store: false`.
- `KimiResearchAgent` — Kimi K3 through the OpenAI-compatible Chat Completions API with JSON mode.
- `MockResearchAgent` — deterministic parameter-varied templates for CI/local smoke tests.
- `MultiAgentResearchCoordinator` — bounded concurrency, per-agent timeout/cancellation, and failure isolation.

Provider output is always passed through the local Strategy DSL validator before backtesting. Agents cannot submit accepted backtest results, p-values, risk approvals, or orders.

The research ledger records provider/model/prompt provenance, performance metrics, deterministic PSR p-values, explicit validation/OOS return paths, and regime return paths. It can construct `trialSharpes`, FDR p-values, selected-trial index, CSCV matrices, and selected-trial regime evidence for `/validate/research` without padding missing evidence.

### Three-way research discipline

```text
Discovery slice
  → candidate + agent context
  → calibrate market-regime thresholds
Validation/OOS slice
  → compare every agent strategy
  → PSR p-value + OOS return path + regime paths → ledger
  → deterministic strategy selection
Final holdout slice
  → selected strategy only
  → /validate/research with ledger evidence
```

This avoids selecting and finally judging the winning strategy on the exact same slice.

## Milestone 6 — deterministic regime robustness evidence

The quant engine derives rolling realized volatility and directional efficiency from close prices. `POST /regimes/calibrate` learns fixed thresholds from the earlier discovery sample only; validation/OOS data never recalibrates them.

`POST /stats/regime-returns` applies the frozen thresholds and groups strategy returns into:

- `volatile` — realized volatility above the calibrated threshold
- `trending` — not volatile and directional efficiency above the trend threshold
- `ranging` — remaining labeled observations

Volatility has precedence so a directional stress episode is stress-tested in the `volatile` bucket instead of being hidden inside `trending`. The first `lookback` observations remain unlabeled because there is insufficient local history; they are not backfilled with future information.

The default `0.67` quantiles and 48-bar lookback are development defaults, not universal trading thresholds.

## Milestone 7 — transactional research ledger

Milestone 7 hardens research persistence for multi-worker deployments.

### Atomic run lifecycle

Every search must atomically claim its `runId` before provider calls or backtests begin. The ledger tracks `RUNNING`, `COMPLETED`, and `FAILED` states, including the selected trial for completed runs. A second worker cannot silently start the same run.

### Idempotent trials

Trials use `(runId, trialId)` identity. Replaying the exact same canonical record returns `duplicate` and does not insert a second row. Reusing that identity with a different payload is rejected as an integrity conflict.

### Strategy audit snapshot

Every newly evaluated trial persists:

- the exact validated `StrategyDefinition` JSON used for backtesting
- a canonical SHA-256 fingerprint computed after recursively sorting object keys
- the existing provider/model/prompt provenance and deterministic statistical evidence

This makes a historical trial reconstructable even if an agent later changes prompts or generates a strategy with the same human-readable name.

### PostgreSQL backend

`PostgresResearchLedger` introduced the `research_runs` and `research_trials` schema, transactional run claims, JSONB audit records, and strategy ID/fingerprint indexes. Milestone 8 keeps that schema compatible while upgrading the runtime to leased/fenced claims.

## Milestone 8 — crash-safe run leases and fencing

`RESEARCH_LEDGER_BACKEND=postgres` now uses `LeasedPostgresResearchLedger`.

A Postgres research run owns an expiring lease containing a random token and monotonically increasing generation. The research executor renews that lease in the background while agent calls, deterministic backtests, statistics, and final validation are running.

If a worker disappears, another worker may reclaim the same `runId` only after the previous lease expires. Reclaim increments the generation and issues a new random token. Every heartbeat, trial append, and terminal transition checks both values plus lease expiry. This is a fencing boundary: a paused old worker that resumes after reclaim cannot append evidence or mark the newer worker's run complete/failed.

Each reclaimed attempt also receives a generation-scoped trial namespace such as `run:g2:001:agent`. Old partial trials remain in the audit ledger but are excluded from the new attempt's DSR/FDR/CSCV/regime evidence, avoiding accidental mixing across attempts.

Default development settings:

```text
RESEARCH_RUN_LEASE_MS=120000
RESEARCH_RUN_HEARTBEAT_MS=30000
```

Use a stable worker identity when your scheduler exposes one:

```text
RESEARCH_WORKER_ID=quant-worker-01
```

The Postgres bootstrap migrates Milestone 7 tables in place by adding lease columns under the existing advisory-lock-protected schema bootstrap. CI exercises active-lease exclusion, heartbeat extension, concurrent stale reclaim, old-worker fencing, terminal non-reclaim, and the complete Postgres-backed research smoke.

Use the durable runtime with:

```bash
RESEARCH_LEDGER_BACKEND=postgres \
DATABASE_URL=postgresql://quant_swarm:password@localhost:5432/quant_swarm \
RESEARCH_POSTGRES_SCHEMA=quant_swarm \
RESEARCH_WORKER_ID=quant-worker-01 \
RESEARCH_PROVIDERS=mock,mock,mock \
pnpm run research:run
```

The JSONL backend remains available for lightweight single-worker/local development and intentionally does not claim multi-host lease safety.

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

Run the original synthetic pipeline:

```bash
pnpm run pipeline
```

Run research with deterministic mock agents and the local JSONL ledger:

```bash
RESEARCH_PROVIDERS=mock,mock,mock pnpm run research:run
```

Use Astra + Kimi research agents after setting their API keys:

```bash
RESEARCH_PROVIDERS=openai,kimi \
OPENAI_API_KEY=... \
KIMI_API_KEY=... \
pnpm run research:run
```

These commands are research-only. They do not place orders or enable live execution.

Run the live candle scanner:

```bash
MARKET_PROVIDER=binance \
MARKET_SUBSCRIPTIONS=BTCUSDT:15m,ETHUSDT:15m \
pnpm run live:scan
```

Run the observation-only market-intelligence scanner:

```bash
INTELLIGENCE_PROVIDER=binance \
INTELLIGENCE_SYMBOLS=BTCUSDT,ETHUSDT \
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

Market-data and market-intelligence adapters require no trading API keys. Research-provider keys are scoped to hypothesis generation and are never persisted to the research ledger. Exchange execution APIs remain disabled. The risk engine supports explicit `reduceOnly` orders and a `KillSwitchStore` abstraction so production deployments can persist kill-switch state outside the process.

## Current limitations / next milestone

- Long-only backtester.
- Purged K-fold is currently bar-horizon based; event-time label-interval purging/CPCV path construction can be added when supervised ML labels enter the platform.
- Regime thresholds are deterministic but relative to a calibration sample; production research should monitor calibration drift across assets/timeframes rather than assume one threshold set is permanent.
- Database schema creation/migration is still application-managed; a versioned external migration system is not implemented yet.
- Provider adapters generate one hypothesis per configured agent call; adaptive budget allocation and candidate-aware fan-out are not implemented yet.
- Milestone 3 intelligence thresholds are baseline development defaults and are not yet regime-adaptive.
- Order-book snapshots are polling-based; persistent local L2 books from snapshot+delta streams are a later optimization.
- Liquidation coverage is venue-specific; Hyperliquid public market-wide liquidation aggregation is intentionally unavailable in the current adapter.
- Kill-switch store defaults to in-memory; a durable production adapter is still required.
- No broker/exchange execution adapter is enabled.

## License

All rights reserved.
