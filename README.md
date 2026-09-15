# Quant Swarm

**AI Quant Research Platform** — Multi-agent hypothesis generation + deterministic backtesting + quant-grade statistical validation.

## Architecture

```
Exchange WebSocket
        ↓
Market Data Normalizer
        ↓
Deterministic Scanner
        ↓
Candidate Event
        ↓
AI Research Orchestrator
        ↓
Strategy DSL (controlled JSON schema)
        ↓
Deterministic Backtester
        ↓
Statistical Validator
        ↓
Independent Risk Engine
        ↓
Shadow / Paper / Live
```

### Key Principles

- **LLM never computes** — all indicators, backtests, and validation are deterministic
- **LLM never executes** — no direct broker/exchange access from AI
- **No bot grades its own output** — maker/checker separation throughout
- **Risk engine is sovereign** — no AI can override limits or kill switches
- **Strategy DSL** — AI produces controlled JSON, not arbitrary code

## Project Structure

```
quant-swarm/
├─ apps/api/                  # TypeScript pipeline orchestrator
├─ packages/
│  ├─ shared/                 # Common types (OHLCV, events)
│  ├─ strategy-schema/        # Strategy DSL + Zod validation
│  ├─ event-bus/              # Internal pub/sub
│  ├─ market-data/            # Exchange adapters (synthetic for now)
│  ├─ risk-contracts/         # Risk engine (LLM-independent)
│  └─ ai-orchestrator/        # Research agent interface
├─ services/
│  └─ quant-engine/           # Python: indicators, backtest, validation
└─ infra/                     # Docker
```

## Quick Start

```bash
# Install dependencies
pnpm install

# Start the Python quant engine
pnpm run dev:engine

# Run the end-to-end pipeline
pnpm run pipeline

# Run all tests
pnpm test
pnpm run test:py
```

## Current Status: Milestone 1

Synthetic BTC data → Scanner → Mock AI → Strategy DSL → Backtest → Validation → Risk → SHADOW_APPROVED

## License

Private — All rights reserved.
