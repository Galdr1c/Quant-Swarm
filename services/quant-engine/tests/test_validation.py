from src.api.server import Candle, PsrRequest, PurgedCvRequest, psr, purged_cv
from src.validation.validator import validate_backtest


def test_validation_passes_healthy_result():
    report = validate_backtest(
        {
            "strategyId": "good",
            "totalTrades": 50,
            "sharpe": 1.2,
            "maxDrawdown": 8.0,
            "profitFactor": 1.5,
            "expectancy": 0.2,
        }
    )
    assert report.overall_verdict == "PASS"


def test_validation_reviews_small_sample():
    report = validate_backtest(
        {
            "strategyId": "small",
            "totalTrades": 10,
            "sharpe": 1.2,
            "maxDrawdown": 8.0,
            "profitFactor": 1.5,
            "expectancy": 0.2,
        }
    )
    assert report.overall_verdict == "REVIEW"


def test_validation_rejects_bad_drawdown_and_expectancy():
    report = validate_backtest(
        {
            "strategyId": "bad",
            "totalTrades": 80,
            "sharpe": 1.0,
            "maxDrawdown": 25.0,
            "profitFactor": 1.3,
            "expectancy": -0.1,
        }
    )
    assert report.overall_verdict == "FAIL"


def test_psr_endpoint_returns_one_sided_p_value_from_equity_curve():
    equity = [100.0]
    for i in range(1, 80):
        # Positive drift with deterministic variation; enough observations for PSR.
        step = 0.002 if i % 5 else -0.0005
        equity.append(equity[-1] * (1.0 + step))

    result = psr(PsrRequest(equityCurve=equity, annualization=365.25 * 24 * 4))
    assert result["observations"] == len(equity) - 1
    assert 0.0 <= result["pValue"] <= 1.0
    assert abs(result["pValue"] - (1.0 - result["probability"])) < 1e-7
    assert result["sharpe"] > 0


def test_purged_cv_endpoint_runs_each_deterministic_test_fold():
    strategy = {
        "id": "cv-strategy",
        "name": "CV strategy",
        "market": {"symbol": "TEST:ABC", "timeframe": "1h"},
        "indicators": [{"id": "ema", "type": "EMA", "params": {"length": 3}}],
        "entry": {
            "operator": "AND",
            "rules": [{"left": "ema", "operator": "<", "right": 1_000_000}],
        },
        "exit": {
            "operator": "OR",
            "rules": [{"left": "ema", "operator": ">", "right": 1_000_001}],
        },
        "risk": {"stopLossPct": 2, "takeProfitPct": 4, "maxPositionPct": 5},
    }
    candles = [
        Candle(
            timestamp=1_700_000_000_000 + index * 3_600_000,
            open=100 + index * 0.1,
            high=101 + index * 0.1,
            low=99 + index * 0.1,
            close=100.5 + index * 0.1,
            volume=1_000 + index,
        )
        for index in range(60)
    ]

    result = purged_cv(
        PurgedCvRequest(
            strategy=strategy,
            candles=candles,
            nSplits=5,
            purgeBars=2,
            embargoBars=1,
        )
    )

    assert result["evaluatedFolds"] == 5
    assert len(result["folds"]) == 5
    assert all(fold["testObservations"] == 12 for fold in result["folds"])
    assert all(fold["trainObservations"] < 48 for fold in result["folds"])
    assert 0.0 <= result["positiveSharpeFraction"] <= 1.0
