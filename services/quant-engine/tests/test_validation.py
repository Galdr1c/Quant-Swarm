from src.api.server import PsrRequest, psr
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
