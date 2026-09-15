from dataclasses import asdict
import math
from typing import Any

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from ..backtest.engine import BacktestConfig, run_backtest
from ..scanners.anomaly_scanner import scan_ohlcv
from ..validation.validator import validate_backtest

app = FastAPI(title="Quant Swarm Engine", version="0.1.0")


class Candle(BaseModel):
    timestamp: int
    open: float
    high: float
    low: float
    close: float
    volume: float


class ScanRequest(BaseModel):
    symbol: str
    candles: list[Candle]
    zThreshold: float = Field(default=3.0, ge=0.5, le=20.0)
    lookbackWindow: int = Field(default=100, ge=10, le=5000)


class BacktestRequest(BaseModel):
    strategy: dict[str, Any]
    candles: list[Candle]
    config: dict[str, Any] | None = None


class ValidateRequest(BaseModel):
    result: dict[str, Any]
    thresholds: dict[str, float] | None = None


def _arrays(candles: list[Candle]) -> tuple[np.ndarray, ...]:
    if not candles:
        raise HTTPException(status_code=400, detail="candles must not be empty")
    return (
        np.asarray([c.timestamp for c in candles], dtype=np.int64),
        np.asarray([c.open for c in candles], dtype=np.float64),
        np.asarray([c.high for c in candles], dtype=np.float64),
        np.asarray([c.low for c in candles], dtype=np.float64),
        np.asarray([c.close for c in candles], dtype=np.float64),
        np.asarray([c.volume for c in candles], dtype=np.float64),
    )


def _json_safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_json_safe(v) for v in value]
    if isinstance(value, float) and not math.isfinite(value):
        return 1e9 if value > 0 else -1e9
    return value


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/scan")
def scan(req: ScanRequest) -> dict[str, Any]:
    ts, o, h, l, c, v = _arrays(req.candles)
    events = scan_ohlcv(
        req.symbol,
        ts,
        o,
        h,
        l,
        c,
        v,
        z_threshold=req.zThreshold,
        lookback_window=req.lookbackWindow,
    )
    return {
        "events": [
            {
                "symbol": e.symbol,
                "type": e.event_type,
                "score": e.score,
                "timestamp": e.timestamp,
                "metadata": e.metadata,
            }
            for e in events
        ]
    }


@app.post("/backtest")
def backtest(req: BacktestRequest) -> dict[str, Any]:
    ts, o, h, l, c, v = _arrays(req.candles)
    try:
        config = BacktestConfig(**(req.config or {}))
        result = run_backtest(req.strategy, o, h, l, c, v, ts, config)
    except (ValueError, TypeError, KeyError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    payload = asdict(result)
    return _json_safe(
        {
            "strategyId": payload["strategy_id"],
            "netReturn": payload["net_return"],
            "annualReturn": payload["annual_return"],
            "sharpe": payload["sharpe"],
            "sortino": payload["sortino"],
            "maxDrawdown": payload["max_drawdown"],
            "profitFactor": payload["profit_factor"],
            "expectancy": payload["expectancy"],
            "totalTrades": payload["total_trades"],
            "winRate": payload["win_rate"],
            "avgWin": payload["avg_win"],
            "avgLoss": payload["avg_loss"],
            "feesPaid": payload["fees_paid"],
            "slippagePaid": payload["slippage_paid"],
            "trades": payload["trades"],
            "equityCurve": payload["equity_curve"],
        }
    )


@app.post("/validate")
def validate(req: ValidateRequest) -> dict[str, Any]:
    report = validate_backtest(req.result, req.thresholds)
    return report.to_dict()
