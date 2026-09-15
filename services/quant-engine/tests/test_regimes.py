import math

from src.validation.regimes import (
    RegimeCalibration,
    calibrate_regime_thresholds,
    classify_regimes,
    regime_features,
    strategy_regime_returns,
)


def test_regime_features_identify_directional_efficiency():
    trending = [100.0 + i * 0.5 for i in range(30)]
    volatility, efficiency = regime_features(trending, lookback=8)

    assert math.isfinite(volatility[-1])
    assert efficiency[-1] > 0.99


def test_calibration_produces_finite_fixed_thresholds():
    prices = [100.0]
    for i in range(1, 160):
        if i < 50:
            change = 0.002
        elif i < 100:
            change = 0.0015 if i % 2 else -0.0014
        else:
            change = 0.007 if i % 3 else -0.009
        prices.append(prices[-1] * (1.0 + change))

    calibration = calibrate_regime_thresholds(prices, lookback=12)
    assert calibration.volatility_high_bps > 0
    assert 0 <= calibration.trend_efficiency_high <= 1
    assert calibration.lookback == 12


def test_classification_and_strategy_returns_cover_three_regimes():
    prices = [100.0]
    # Low-volatility directional trend.
    for _ in range(15):
        prices.append(prices[-1] * 1.001)
    # Low-volatility back-and-forth range.
    for i in range(18):
        prices.append(prices[-1] * (1.0006 if i % 2 else 0.9994))
    # High-volatility stress episode.
    for i in range(20):
        prices.append(prices[-1] * (1.012 if i % 2 else 0.989))

    calibration = RegimeCalibration(
        lookback=5,
        volatility_high_bps=35.0,
        trend_efficiency_high=0.80,
        volatility_quantile=0.67,
        trend_quantile=0.67,
    )
    labels = classify_regimes(prices, calibration)
    observed = {label for label in labels if label is not None}
    assert observed == {"trending", "ranging", "volatile"}

    equity = [100_000.0]
    for i in range(1, len(prices)):
        strategy_return = 0.0012 if i % 6 else -0.0004
        equity.append(equity[-1] * (1.0 + strategy_return))

    grouped = strategy_regime_returns(equity, prices, calibration)
    assert set(grouped) == {"trending", "ranging", "volatile"}
    assert all(len(grouped[name]) >= 2 for name in grouped)
