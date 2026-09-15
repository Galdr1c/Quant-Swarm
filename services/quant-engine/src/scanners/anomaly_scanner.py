"""
Deterministic anomaly scanner.

Detects volume spikes, price dislocations, and volatility expansions using
z-scores against *prior* observations only. The current bar is never included
in its own baseline, avoiding self-damping and look-ahead-like behavior.
"""

from dataclasses import dataclass, field
from typing import Any

import numpy as np
from numpy.typing import NDArray


@dataclass
class CandidateEvent:
    symbol: str
    event_type: str
    score: float
    timestamp: int
    metadata: dict[str, Any] = field(default_factory=dict)


def compute_z_scores(values: NDArray, window: int) -> NDArray:
    """Compute current-value z-score against the previous `window` values."""
    if window < 2:
        raise ValueError("window must be >= 2")

    arr = np.asarray(values, dtype=np.float64)
    result = np.full(arr.shape, np.nan, dtype=np.float64)
    if len(arr) <= window:
        return result

    for i in range(window, len(arr)):
        history = arr[i - window : i]
        current = arr[i]
        if not np.isfinite(current) or not np.all(np.isfinite(history)):
            continue
        mean = float(np.mean(history))
        std = float(np.std(history, ddof=1))
        result[i] = (current - mean) / std if std > 1e-10 else 0.0

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
    """Scan OHLCV data for deterministic anomaly candidates."""
    events: list[CandidateEvent] = []

    arrays = [timestamps, open_arr, high, low, close, volume]
    n = len(close)
    if any(len(a) != n for a in arrays):
        raise ValueError("OHLCV arrays must have identical lengths")
    if n <= lookback_window + 1:
        return events

    volume_z = compute_z_scores(volume, lookback_window)

    log_returns = np.full(n, np.nan, dtype=np.float64)
    valid_prices = (close[1:] > 0) & (close[:-1] > 0)
    computed_returns = np.full(n - 1, np.nan, dtype=np.float64)
    computed_returns[valid_prices] = np.log(close[1:][valid_prices] / close[:-1][valid_prices])
    log_returns[1:] = computed_returns
    return_z = compute_z_scores(log_returns, lookback_window)

    from ..indicators.technical import atr as compute_atr

    atr_values = compute_atr(high, low, close, 14)
    atr_z = compute_z_scores(atr_values, lookback_window)

    for i in range(lookback_window, n):
        ts = int(timestamps[i])

        if np.isfinite(volume_z[i]) and abs(volume_z[i]) >= z_threshold:
            events.append(
                CandidateEvent(
                    symbol=symbol,
                    event_type="VOLUME_ANOMALY",
                    score=float(abs(volume_z[i])),
                    timestamp=ts,
                    metadata={"volume_z_score": round(float(volume_z[i]), 4)},
                )
            )

        if np.isfinite(return_z[i]) and abs(return_z[i]) >= z_threshold:
            events.append(
                CandidateEvent(
                    symbol=symbol,
                    event_type="PRICE_DISLOCATION",
                    score=float(abs(return_z[i])),
                    timestamp=ts,
                    metadata={"return_z_score": round(float(return_z[i]), 4)},
                )
            )

        if np.isfinite(atr_z[i]) and atr_z[i] >= z_threshold:
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
