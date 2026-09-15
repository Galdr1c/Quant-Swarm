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
