"""
Strategy runner: converts Strategy DSL JSON into entry/exit signals.

Takes a strategy definition and OHLCV data, computes all indicators,
evaluates rules, and produces boolean signal arrays.
"""

import numpy as np
from numpy.typing import NDArray

from ..indicators.technical import ema, sma, rsi, atr, macd, supertrend, bollinger_bands


# ─── Indicator Computation ────────────────────────────────────────────────────

def compute_indicator(
    indicator_def: dict,
    open_arr: NDArray,
    high: NDArray,
    low: NDArray,
    close: NDArray,
    volume: NDArray,
) -> NDArray:
    """Compute a single indicator from its DSL definition."""
    ind_type = indicator_def["type"]
    params = indicator_def.get("params", {})

    if ind_type == "EMA":
        return ema(close, int(params.get("length", 20)))
    elif ind_type == "SMA":
        return sma(close, int(params.get("length", 20)))
    elif ind_type == "RSI":
        return rsi(close, int(params.get("length", 14)))
    elif ind_type == "ATR":
        return atr(high, low, close, int(params.get("length", 14)))
    elif ind_type == "MACD":
        fast = int(params.get("fastLength", params.get("length", 12)))
        slow = int(params.get("slowLength", 26))
        signal = int(params.get("signalLength", 9))
        macd_line, _, histogram = macd(close, fast, slow, signal)
        # Return histogram as the primary MACD value for rule comparison
        return histogram
    elif ind_type == "SUPERTREND":
        factor = float(params.get("factor", 3.0))
        atr_len = int(params.get("atrLength", 10))
        return supertrend(high, low, close, factor, atr_len)
    elif ind_type == "BBANDS":
        length = int(params.get("length", 20))
        std = float(params.get("stddev", 2.0))
        upper, middle, lower = bollinger_bands(close, length, std)
        return middle  # Return middle band as primary
    elif ind_type == "VWAP":
        cum_vp = np.cumsum(close * volume)
        cum_v = np.cumsum(volume)
        return np.where(cum_v > 0, cum_vp / cum_v, close)
    else:
        raise ValueError(f"Unknown indicator type: {ind_type}")


# ─── Rule Evaluation ─────────────────────────────────────────────────────────

def evaluate_rule(
    rule: dict,
    indicators: dict[str, NDArray],
    close: NDArray,
) -> NDArray:
    """Evaluate a single rule, returning a boolean array."""
    left_id = rule["left"]
    operator = rule["operator"]
    right = rule["right"]

    left_values = indicators.get(left_id, close)

    if isinstance(right, str):
        right_values = indicators.get(right, close)
    else:
        right_values = np.full_like(close, float(right), dtype=np.float64)

    n = len(close)
    result = np.zeros(n, dtype=bool)

    if operator == ">":
        valid = ~np.isnan(left_values) & ~np.isnan(right_values)
        result[valid] = left_values[valid] > right_values[valid]
    elif operator == "<":
        valid = ~np.isnan(left_values) & ~np.isnan(right_values)
        result[valid] = left_values[valid] < right_values[valid]
    elif operator == ">=":
        valid = ~np.isnan(left_values) & ~np.isnan(right_values)
        result[valid] = left_values[valid] >= right_values[valid]
    elif operator == "<=":
        valid = ~np.isnan(left_values) & ~np.isnan(right_values)
        result[valid] = left_values[valid] <= right_values[valid]
    elif operator == "crosses_above":
        valid = ~np.isnan(left_values) & ~np.isnan(right_values)
        for i in range(1, n):
            if valid[i] and valid[i - 1]:
                result[i] = (
                    left_values[i] > right_values[i]
                    and left_values[i - 1] <= right_values[i - 1]
                )
    elif operator == "crosses_below":
        valid = ~np.isnan(left_values) & ~np.isnan(right_values)
        for i in range(1, n):
            if valid[i] and valid[i - 1]:
                result[i] = (
                    left_values[i] < right_values[i]
                    and left_values[i - 1] >= right_values[i - 1]
                )

    return result


def evaluate_rule_group(
    group: dict,
    indicators: dict[str, NDArray],
    close: NDArray,
) -> NDArray:
    """Evaluate a rule group (AND/OR), returning a boolean array."""
    rules = group["rules"]
    operator = group["operator"]

    if not rules:
        return np.zeros(len(close), dtype=bool)

    signals = [evaluate_rule(rule, indicators, close) for rule in rules]

    if operator == "AND":
        combined = signals[0].copy()
        for s in signals[1:]:
            combined &= s
        return combined
    else:  # OR
        combined = signals[0].copy()
        for s in signals[1:]:
            combined |= s
        return combined


def generate_signals(
    strategy: dict,
    open_arr: NDArray,
    high: NDArray,
    low: NDArray,
    close: NDArray,
    volume: NDArray,
) -> tuple[NDArray, NDArray]:
    """
    Generate entry and exit signal arrays from a strategy definition.

    Returns (entry_signals, exit_signals) as boolean arrays.
    """
    # Compute all indicators
    indicators: dict[str, NDArray] = {}
    for ind_def in strategy["indicators"]:
        indicators[ind_def["id"]] = compute_indicator(
            ind_def, open_arr, high, low, close, volume
        )

    entry_signals = evaluate_rule_group(strategy["entry"], indicators, close)
    exit_signals = evaluate_rule_group(strategy["exit"], indicators, close)

    return entry_signals, exit_signals
