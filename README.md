# Quant Swarm

**AI Quant Research Platform** — multi-agent hypothesis generation, deterministic backtesting, statistical validation, and an AI-independent risk layer.

## Architecture

```text
Market Data Provider
        ↓
Deterministic Scanner
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
│  └─ api/                    # TypeScript pipeline orchestrator
├─ packages/
│  ├─ shared/                 # Shared contracts
│  ├─ strategy-schema/        # Zod strategy DSL
│  ├─ event-bus/              # Typed in-process event bus
│  ├─ market-data/            # Providers; synthetic in Milestone 1
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

## Milestone 1

The implemented end-to-end path is:

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

The current validator is intentionally a **baseline gate**, not yet a full quant-grade research validator. Walk-forward analysis, purged/embargoed cross-validation, Deflated Sharpe Ratio, multiple-testing correction, and regime robustness belong to the next milestone.

The local technical-rating implementation exported as `technical_rating_approx` is explicitly an approximation. It uses 15 moving-average style signals and 11 oscillator signals, including real HMA and VWMA20 calculations; it is not represented as TradingView server output.

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

In another terminal, run the end-to-end pipeline:

```bash
pnpm run pipeline
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

The risk engine supports explicit `reduceOnly` orders and a `KillSwitchStore` abstraction so production deployments can persist kill-switch state outside the process.

## Current limitations

- Synthetic market data only in the default pipeline.
- Long-only backtester in Milestone 1.
- Baseline statistical validator only.
- Kill-switch store defaults to in-memory; a durable production adapter is still required.
- No broker/exchange execution adapter is enabled.
- No OpenAI/Kimi production research adapter is enabled yet.

## License

All rights reserved.
