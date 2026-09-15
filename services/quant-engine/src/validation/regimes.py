"""Deterministic market-regime classification for research validation.

Regime thresholds are calibrated on an earlier discovery/calibration sample and
then applied unchanged to validation/OOS data. This keeps regime robustness as
an auditable post-research diagnostic rather than an LLM opinion and avoids
learning thresholds from the same final holdout being judged.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Iterable

import numpy as np
from numpy.typing import NDArray


REGIME_NAMES = ("trending", "ranging", "volatile")


@dataclass(frozen=True)
class RegimeCalibration:
    lookback: int
    volatility_high_bps: float
    trend_efficiency_high: float
    volatility_quantile: float
    trend_quantile: float

    def to_dict(self) -> dict[str, float | int]:
        return {
            "lookback": self.lookback,
            "volatilityHighBps": self.volatility_high_bps,
            "trendEfficiencyHigh": self.trend_efficiency_high,
            "volatilityQuantile": self.volatility_quantile,
            "trendQuantile": self.trend_quantile,
        }


def regime_features(
    close: Iterable[float],
    lookback: int,
) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    """Return rolling realized-volatility (bps) and directional efficiency.

    Volatility is the sample standard deviation of log returns over ``lookback``
    intervals, expressed in basis points per observation. Directional efficiency
    is net absolute price displacement divided by total absolute path length and
    therefore lies in [0, 1].
    """
    prices = _prices(close)
    if lookback < 3:
        raise ValueError("lookback must be at least 3")
    if prices.size <= lookback:
        raise ValueError("close series must contain more observations than lookback")

    log_returns = np.diff(np.log(prices))
    volatility = np.full(prices.size, np.nan, dtype=np.float64)
    efficiency = np.full(prices.size, np.nan, dtype=np.float64)

    for i in range(lookback, prices.size):
        window_returns = log_returns[i - lookback : i]
        volatility[i] = float(np.std(window_returns, ddof=1) * 10_000.0)

        window_prices = prices[i - lookback : i + 1]
        path = float(np.sum(np.abs(np.diff(window_prices))))
        displacement = float(abs(window_prices[-1] - window_prices[0]))
        efficiency[i] = displacement / path if path > 1e-15 else 0.0

    return volatility, efficiency


def calibrate_regime_thresholds(
    close: Iterable[float],
    lookback: int = 48,
    volatility_quantile: float = 0.67,
    trend_quantile: float = 0.67,
) -> RegimeCalibration:
    """Calibrate fixed thresholds from an earlier market sample."""
    if not 0.5 <= volatility_quantile <= 0.95:
        raise ValueError("volatility_quantile must be in [0.5, 0.95]")
    if not 0.5 <= trend_quantile <= 0.95:
        raise ValueError("trend_quantile must be in [0.5, 0.95]")

    volatility, efficiency = regime_features(close, lookback)
    valid_vol = volatility[np.isfinite(volatility)]
    valid_eff = efficiency[np.isfinite(efficiency)]
    if valid_vol.size < max(10, lookback // 2) or valid_eff.size < max(10, lookback // 2):
        raise ValueError("calibration sample is too short for stable regime thresholds")

    vol_threshold = float(np.quantile(valid_vol, volatility_quantile))
    trend_threshold = float(np.quantile(valid_eff, trend_quantile))
    if not math.isfinite(vol_threshold) or not math.isfinite(trend_threshold):
        raise ValueError("regime thresholds are non-finite")

    return RegimeCalibration(
        lookback=int(lookback),
        volatility_high_bps=vol_threshold,
        trend_efficiency_high=trend_threshold,
        volatility_quantile=float(volatility_quantile),
        trend_quantile=float(trend_quantile),
    )


def classify_regimes(
    close: Iterable[float],
    calibration: RegimeCalibration,
) -> list[str | None]:
    """Apply fixed calibration thresholds to a new price sample.

    Volatility takes precedence because a strongly directional but unusually
    volatile episode should be stress-tested in the volatile bucket first.
    """
    volatility, efficiency = regime_features(close, calibration.lookback)
    labels: list[str | None] = [None] * len(volatility)

    for i in range(len(labels)):
        vol = float(volatility[i])
        eff = float(efficiency[i])
        if not math.isfinite(vol) or not math.isfinite(eff):
            continue
        if vol >= calibration.volatility_high_bps:
            labels[i] = "volatile"
        elif eff >= calibration.trend_efficiency_high:
            labels[i] = "trending"
        else:
            labels[i] = "ranging"

    return labels


def strategy_regime_returns(
    equity_curve: Iterable[float],
    close: Iterable[float],
    calibration: RegimeCalibration,
) -> dict[str, list[float]]:
    """Group strategy equity returns by the contemporaneous market regime."""
    equity = np.asarray(list(equity_curve), dtype=np.float64)
    prices = _prices(close)
    if equity.size != prices.size:
        raise ValueError("equity_curve and close series must have identical lengths")
    if equity.size <= calibration.lookback:
        raise ValueError("evaluation sample is too short for regime lookback")

    labels = classify_regimes(prices, calibration)
    grouped: dict[str, list[float]] = {name: [] for name in REGIME_NAMES}

    for i in range(1, equity.size):
        label = labels[i]
        previous = float(equity[i - 1])
        current = float(equity[i])
        if label is None or not math.isfinite(previous) or not math.isfinite(current) or previous == 0:
            continue
        value = (current - previous) / previous
        if math.isfinite(value):
            grouped[label].append(float(value))

    return grouped


def _prices(close: Iterable[float]) -> NDArray[np.float64]:
    prices = np.asarray(list(close), dtype=np.float64)
    if prices.size < 2:
        raise ValueError("close series must contain at least two observations")
    if not np.all(np.isfinite(prices)) or np.any(prices <= 0):
        raise ValueError("close series must contain only finite positive values")
    return prices
