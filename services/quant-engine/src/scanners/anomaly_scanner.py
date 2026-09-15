"""
Deterministic anomaly scanner.

Detects volume spikes, price dislocations, and volatility expansions
using z-scores over rolling windows. No LLM involved.
"""

from dataclasses import dataclass, field
from typing import Any

import numpy as np
from numpy.typing import NDArray


@dataclass
class CandidateEvent:
    symbol: str
    event_type: str  # VOLUME_ANOMALY | PRICE_DISLOCATION | VOLATILITY_EXPANSION
    score: float
    timestamp: int
    metadata: dict[str, Any] = field(default_factory=dict)


def compute_z_scores(values: NDArray, window: int) -> NDArray:
    """Rolling z-score calculation."""
    result = np.full_like(values, np.nan, dtype=np.float64)
    if len(values) < window:
        return result

    for i in range(window - 1, len(values)):
        window_data = values[i - window + 1 : i + 1]
        mean = np.mean(window_data)
        std = np.std(window_data, ddof=1)
        if std > 1e-10:
            result[i] = (values[i] - mean) / std
        else:
            result[i] = 0.0

    return result


def scan_ohlcv(
    symbol: str,
    timestamps: NDArray,
    open_arr: NDArray,
    high: NDArray,
    low: NDArray,
    close: NDArray,
    volume: NDArray,
    z_threshold: float = 3.0,
    lookback_window: int = 100,
) -> list[CandidateEvent]:
    """
    Scan OHLCV data for anomalies.

    Returns CandidateEvents where z-scores exceed threshold.
    Designed to filter 10,000 observations down to ~10-20 interesting events.
    """
    events: list[CandidateEvent] = []

    if len(close) < lookback_window + 1:
        return events

    # Volume z-scores
    volume_z = compute_z_scores(volume, lookback_window)

    # Return z-scores (log returns)
    log_returns = np.full_like(close, np.nan, dtype=np.float64)
    log_returns[1:] = np.log(close[1:] / close[:-1])
    return_z = compute_z_scores(log_returns, lookback_window)

    # ATR-based volatility expansion
    from ..indicators.technical import atr as compute_atr

    atr_values = compute_atr(high, low, close, 14)
    atr_z = compute_z_scores(atr_values, lookback_window)

    for i in range(lookback_window, len(close)):
        ts = int(timestamps[i]) if i < len(timestamps) else 0

        # Volume anomaly
        if not np.isnan(volume_z[i]) and abs(volume_z[i]) >= z_threshold:
            events.append(
                CandidateEvent(
                    symbol=symbol,
                    event_type="VOLUME_ANOMALY",
                    score=float(abs(volume_z[i])),
                    timestamp=ts,
                    metadata={"volume_z_score": round(float(volume_z[i]), 4)},
                )
            )

        # Price dislocation
        if not np.isnan(return_z[i]) and abs(return_z[i]) >= z_threshold:
            events.append(
                CandidateEvent(
                    symbol=symbol,
                    event_type="PRICE_DISLOCATION",
                    score=float(abs(return_z[i])),
                    timestamp=ts,
                    metadata={"return_z_score": round(float(return_z[i]), 4)},
                )
            )

        # Volatility expansion
        if not np.isnan(atr_z[i]) and atr_z[i] >= z_threshold:
            events.append(
                CandidateEvent(
                    symbol=symbol,
                    event_type="VOLATILITY_EXPANSION",
                    score=float(atr_z[i]),
                    timestamp=ts,
                    metadata={"atr_z_score": round(float(atr_z[i]), 4)},
                )
            )

    return events
