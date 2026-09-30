from dataclasses import asdict
import math
from typing import Any

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from ..backtest.engine import BacktestConfig, run_backtest
from ..scanners.anomaly_scanner import scan_ohlcv
from ..validation.advanced import (
    equity_returns,
    probabilistic_sharpe_ratio,
    purged_kfold_splits,
    sharpe_ratio,
)
from ..validation.regimes import (
    RegimeCalibration,
    calibrate_regime_thresholds,
    strategy_regime_returns,
)
from ..validation.research_validator import validate_research
from ..validation.validator import validate_backtest

app = FastAPI(title="Quant Swarm Engine", version="0.4.0")


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


class PurgedCvRequest(BaseModel):
    strategy: dict[str, Any]
    candles: list[Candle]
    nSplits: int = Field(default=5, ge=2, le=20)
    purgeBars: int = Field(default=1, ge=0, le=500)
    embargoBars: int = Field(default=1, ge=0, le=500)
    config: dict[str, Any] | None = None


class ValidateRequest(BaseModel):
    result: dict[str, Any]
    thresholds: dict[str, float] | None = None


class ResearchValidateRequest(BaseModel):
    result: dict[str, Any]
    evidence: dict[str, Any] = Field(default_factory=dict)
    thresholds: dict[str, float] | None = None


class PsrRequest(BaseModel):
    equityCurve: list[float]
    benchmarkSharpe: float = 0.0
    annualization: float = Field(default=1.0, gt=0.0)


class RegimeCalibrationRequest(BaseModel):
    candles: list[Candle]
    lookback: int = Field(default=48, ge=3, le=5000)
    volatilityQuantile: float = Field(default=0.67, ge=0.5, le=0.95)
    trendQuantile: float = Field(default=0.67, ge=0.5, le=0.95)


class RegimeThresholds(BaseModel):
    lookback: int = Field(ge=3, le=5000)
    volatilityHighBps: float = Field(ge=0.0)
    trendEfficiencyHigh: float = Field(ge=0.0, le=1.0)
    volatilityQuantile: float = Field(default=0.67, ge=0.5, le=0.95)
    trendQuantile: float = Field(default=0.67, ge=0.5, le=0.95)


class RegimeReturnsRequest(BaseModel):
    candles: list[Candle]
    equityCurve: list[float]
    calibration: RegimeThresholds


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
            "annualization": payload["annualization"],
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


@app.post("/validate/purged-cv")
def purged_cv(req: PurgedCvRequest) -> dict[str, Any]:
    """Evaluate one fixed Strategy DSL on each purged/embargoed test fold.

    The strategy is already fully specified, so no synthetic refit step is
    invented. Training indices are still reported to prove the requested
    purge/embargo separation, while every fold's test block is independently
    backtested by the deterministic engine.
    """
    if len(req.candles) < max(req.nSplits * 4, 20):
        raise HTTPException(
            status_code=400,
            detail="candles are too short for deterministic purged CV folds",
        )

    try:
        splits = purged_kfold_splits(
            n_samples=len(req.candles),
            n_splits=req.nSplits,
            purge=req.purgeBars,
            embargo=req.embargoBars,
        )
        config = BacktestConfig(**(req.config or {}))
        folds: list[dict[str, Any]] = []

        for fold_index, split in enumerate(splits):
            test_indices = split.test_indices
            if len(test_indices) < 4:
                raise ValueError(
                    f"fold {fold_index + 1} has fewer than four test observations"
                )
            test_candles = [req.candles[index] for index in test_indices]
            ts, o, h, l, close, volume = _arrays(test_candles)
            result = run_backtest(
                req.strategy,
                o,
                h,
                l,
                close,
                volume,
                ts,
                config,
            )
            payload = asdict(result)
            folds.append(
                {
                    "fold": fold_index + 1,
                    "trainObservations": len(split.train_indices),
                    "testObservations": len(test_indices),
                    "testStartTimestamp": int(test_candles[0].timestamp),
                    "testEndTimestamp": int(test_candles[-1].timestamp),
                    "sharpe": float(payload["sharpe"]),
                    "netReturn": float(payload["net_return"]),
                    "maxDrawdown": float(payload["max_drawdown"]),
                    "totalTrades": int(payload["total_trades"]),
                    "annualization": float(payload["annualization"]),
                }
            )
    except (ValueError, TypeError, KeyError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    sharpes = np.asarray([fold["sharpe"] for fold in folds], dtype=np.float64)
    returns = np.asarray([fold["netReturn"] for fold in folds], dtype=np.float64)
    drawdowns = np.asarray([fold["maxDrawdown"] for fold in folds], dtype=np.float64)
    return _json_safe(
        {
            "nObservations": len(req.candles),
            "nSplits": req.nSplits,
            "purgeBars": req.purgeBars,
            "embargoBars": req.embargoBars,
            "evaluatedFolds": len(folds),
            "positiveSharpeFraction": float(np.mean(sharpes > 0.0)),
            "medianSharpe": float(np.median(sharpes)),
            "meanNetReturn": float(np.mean(returns)),
            "worstMaxDrawdown": float(np.max(drawdowns)),
            "folds": folds,
        }
    )


@app.post("/stats/psr")
def psr(req: PsrRequest) -> dict[str, Any]:
    """Return deterministic Sharpe significance evidence from an equity curve."""
    returns = equity_returns(req.equityCurve)
    if len(returns) < 3:
        raise HTTPException(status_code=400, detail="equityCurve must produce at least three finite returns")

    probability = probabilistic_sharpe_ratio(
        returns,
        benchmark_sharpe=req.benchmarkSharpe,
        annualization=req.annualization,
    )
    if not math.isfinite(probability):
        raise HTTPException(status_code=400, detail="PSR could not be evaluated for this equity curve")

    observed_sharpe = sharpe_ratio(returns, annualization=req.annualization)
    return {
        "probability": round(float(probability), 8),
        "pValue": round(float(1.0 - probability), 8),
        "sharpe": round(float(observed_sharpe), 8),
        "observations": int(len(returns)),
        "benchmarkSharpe": float(req.benchmarkSharpe),
        "annualization": float(req.annualization),
    }


@app.post("/regimes/calibrate")
def calibrate_regimes(req: RegimeCalibrationRequest) -> dict[str, Any]:
    """Calibrate fixed market-regime thresholds on an earlier discovery sample."""
    _, _, _, _, close, _ = _arrays(req.candles)
    try:
        calibration = calibrate_regime_thresholds(
            close,
            lookback=req.lookback,
            volatility_quantile=req.volatilityQuantile,
            trend_quantile=req.trendQuantile,
        )
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return calibration.to_dict()


@app.post("/stats/regime-returns")
def regime_returns(req: RegimeReturnsRequest) -> dict[str, Any]:
    """Group a strategy equity path by market regimes using fixed thresholds."""
    _, _, _, _, close, _ = _arrays(req.candles)
    calibration = RegimeCalibration(
        lookback=req.calibration.lookback,
        volatility_high_bps=req.calibration.volatilityHighBps,
        trend_efficiency_high=req.calibration.trendEfficiencyHigh,
        volatility_quantile=req.calibration.volatilityQuantile,
        trend_quantile=req.calibration.trendQuantile,
    )
    try:
        grouped = strategy_regime_returns(req.equityCurve, close, calibration)
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    counts = {name: len(values) for name, values in grouped.items()}
    labeled = sum(counts.values())
    possible_returns = max(len(req.equityCurve) - 1, 0)
    return {
        "regimeReturns": grouped,
        "counts": counts,
        "labeledObservations": labeled,
        "unlabeledObservations": max(possible_returns - labeled, 0),
        "calibration": calibration.to_dict(),
    }


@app.post("/validate")
def validate(req: ValidateRequest) -> dict[str, Any]:
    report = validate_backtest(req.result, req.thresholds)
    return report.to_dict()


@app.post("/validate/research")
def validate_research_evidence(req: ResearchValidateRequest) -> dict[str, Any]:
    """Validate a backtest plus evidence from the broader strategy-search process.

    Missing DSR/PBO/FDR/regime/CV evidence is deliberately returned as REVIEW,
    never silently promoted to PASS.
    """
    try:
        report = validate_research(req.result, req.evidence, req.thresholds)
    except (ValueError, TypeError, KeyError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _json_safe(report.to_dict())
