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
Validation/OOS Backtests → Append-only Research Ledger
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
- **Research history is auditable** — evaluated trials are appended to a research ledger with provider/model provenance and numeric evidence.
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
│  ├─ research-ledger/        # Append-only trial history + validation evidence builder
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

Normalized fields include best bid/ask, midpoint/spread, quote-notional depth and imbalance, funding, open interest, mark/index-oracle basis, liquidation notional where a public feed exists, and source latency metadata.

Implemented public-data sources:

- **Binance USDⓈ-M Futures** — `/fapi/v1/depth`, `/fapi/v1/premiumIndex`, `/fapi/v1/openInterest`, plus `<symbol>@forceOrder` liquidation streams on the current futures market WebSocket route.
- **Bybit V5 linear/inverse** — `/v5/market/orderbook`, `/v5/market/tickers`, plus `allLiquidation.{symbol}` WebSocket topics. The default configuration is linear contracts.
- **Hyperliquid** — `l2Book` plus `metaAndAssetCtxs`; funding, open interest, mark price and oracle price are joined by asset index. No equivalent public market-wide liquidation feed is fabricated; those fields remain `null`.

`MarketIntelligenceScanner` deterministically emits `ORDERBOOK_IMBALANCE`, `FUNDING_EXTREME`, `OPEN_INTEREST_EXPANSION`, `BASIS_DISLOCATION`, `SPREAD_WIDENING`, `LIQUIDATION_SPIKE`, and rolling-return `VOLATILITY_EXPANSION` candidates with per exchange/symbol/type cooldowns.

## Milestone 4 — research-grade statistical validation

The original `/validate` endpoint remains the stable baseline gate. `/validate/research` adds research-process evidence that is required once the platform starts searching many strategies and parameter combinations.

Implemented deterministic controls:

- **Probabilistic Sharpe Ratio (PSR)** with finite-sample skew/kurtosis adjustment.
- **Deflated Sharpe Ratio (DSR)** using the observed distribution of trial Sharpes to raise the benchmark after multiple strategy searches.
- **Benjamini–Hochberg FDR** correction for candidate p-values.
- **CSCV / Probability of Backtest Overfitting (PBO)** from an observations × strategy-trials return matrix.
- **Purged + embargoed K-fold plans** for fixed-horizon time-series labels.
- **Regime robustness** from per-regime return series and the fraction of regimes with positive Sharpe.

Advanced evidence is intentionally not inferred from one winning backtest. If DSR/PBO/FDR/regime/CV evidence is missing, `/validate/research` reports the affected checks as `REVIEW`; it never converts missing evidence into a pass.

The quant engine exposes `/stats/psr` so one-sided candidate p-values used by FDR are computed in Python from the actual equity curve instead of being fabricated by an agent or TypeScript orchestration code.

Methodology references include Bailey & López de Prado, *The Deflated Sharpe Ratio* (2014), and Bailey, Borwein, López de Prado & Zhu, *The Probability of Backtest Overfitting* (2017). The implementation is transparent and locally testable rather than delegating these calculations to an AI agent.

## Milestone 5 — research ledger + production agent adapters

Milestone 5 connects multi-agent hypothesis generation to the deterministic research stack without giving the models authority over statistics or execution.

### Research agents

`@quant-swarm/ai-orchestrator` includes:

- `OpenAIResearchAgent` — GPT-6 Astra through the Responses API, Structured JSON output, configurable reasoning effort, and `store: false`.
- `KimiResearchAgent` — Kimi K3 through the OpenAI-compatible Chat Completions API with JSON mode and `low` / `high` / `max` reasoning effort.
- `MockResearchAgent` — deterministic, parameter-varied templates used by CI and local smoke tests.
- `MultiAgentResearchCoordinator` — bounded concurrency, per-agent timeout/cancellation, and failure isolation.

Provider output is always passed through the local Strategy DSL validator before it can enter backtesting. Agents cannot submit accepted backtest results, p-values, risk approvals, or orders.

### Append-only research ledger

`@quant-swarm/research-ledger` records each successfully evaluated trial with:

- run/trial IDs and candidate event
- strategy ID and agent confidence
- provider, model, prompt version and optional response ID
- Sharpe, return, drawdown, profit factor and expectancy
- deterministic PSR p-value
- explicit validation/OOS return path
- deterministic per-regime return paths

The JSONL implementation stores research metadata and numeric evidence only. API keys, authorization headers, raw provider requests, and hidden reasoning/chain-of-thought are not written to the ledger. OOS and regime paths are rejected if they contain non-finite values.

The ledger can build `trialSharpes`, candidate p-values, selected-trial index, an observations × trials CSCV matrix, and selected-trial regime evidence directly for `/validate/research`. Incomplete evidence is omitted rather than padded.

### Three-way research discipline

The `research:run` path separates data usage:

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

Milestone 6 removes the remaining manual regime-evidence gap from the research-search path.

The quant engine now derives two rolling market features from close prices:

- **realized volatility** — sample standard deviation of rolling log returns, expressed in basis points per observation
- **directional efficiency** — absolute net displacement divided by total absolute price path length, bounded to `[0, 1]`

`POST /regimes/calibrate` computes fixed volatility and directional-efficiency thresholds from the earlier discovery sample using configurable quantiles. Those thresholds are then frozen. Validation/OOS data never recalibrates them.

`POST /stats/regime-returns` applies the frozen thresholds to a strategy equity curve and groups its returns into:

- `volatile` — realized volatility is above the calibrated high-volatility threshold
- `trending` — not volatile, and directional efficiency is above the calibrated trend threshold
- `ranging` — the remaining labeled observations

Volatility has precedence so a strongly directional stress episode is stress-tested in the `volatile` bucket rather than being hidden inside `trending`.

The research executor calibrates once on discovery data, computes regime returns for every validation/OOS trial in Python, persists those paths in the research ledger, and automatically supplies the selected trial's three-bucket evidence to `/validate/research`. The first `lookback` observations in each evaluation slice are deliberately unlabeled because there is insufficient local history; they are not backfilled with future information.

The default `0.67` quantiles and 48-bar lookback are development calibration defaults, not trading signals or universal market constants.

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

Run the research smoke with deterministic mock agents:

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

This command is research-only. It does not place orders or enable live execution.

Run the Milestone 2 live candle scanner:

```bash
MARKET_PROVIDER=binance \
MARKET_SUBSCRIPTIONS=BTCUSDT:15m,ETHUSDT:15m \
pnpm run live:scan
```

Run the Milestone 3 observation-only market-intelligence scanner:

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
- JSONL research ledger is intended for a single research worker/process; production multi-worker deployment needs a durable transactional ledger (for example Postgres).
- Provider adapters generate one hypothesis per configured agent call; adaptive budget allocation and candidate-aware fan-out are not implemented yet.
- Milestone 3 intelligence thresholds are baseline development defaults and are not yet regime-adaptive.
- Order-book snapshots are polling-based; persistent local L2 books from snapshot+delta streams are a later optimization.
- Liquidation coverage is venue-specific; Hyperliquid public market-wide liquidation aggregation is intentionally unavailable in the current adapter.
- Kill-switch store defaults to in-memory; a durable production adapter is still required.
- No broker/exchange execution adapter is enabled.

## License

All rights reserved.
