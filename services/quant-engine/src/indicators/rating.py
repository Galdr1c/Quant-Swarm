"""
TradingView-style 26-signal technical rating approximation.

This is intentionally named and reported as an approximation. It is computed
locally and is not represented as TradingView's proprietary server output.
Compared with the legacy helper it uses a real Hull MA, VWMA(20), and
trend/direction conditions for threshold oscillators.
"""

import math
import numpy as np
from numpy.typing import NDArray

from .technical import (
    awesome_oscillator,
    cci,
    ema,
    macd,
    momentum,
    rsi,
    sma,
    stochastic,
    ultimate_oscillator,
    williams_r,
)


def wma(values: NDArray, length: int) -> NDArray:
    out = np.full_like(values, np.nan, dtype=np.float64)
    if length <= 0 or len(values) < length:
        return out
    weights = np.arange(1, length + 1, dtype=np.float64)
    denom = float(np.sum(weights))
    for i in range(length - 1, len(values)):
        window = values[i - length + 1 : i + 1]
        if np.all(np.isfinite(window)):
            out[i] = float(np.dot(window, weights) / denom)
    return out


def hma(values: NDArray, length: int = 9) -> NDArray:
    half = max(1, length // 2)
    root = max(1, int(round(math.sqrt(length))))
    fast = wma(values, half)
    slow = wma(values, length)
    raw = 2.0 * fast - slow
    return wma(raw, root)


def vwma(close: NDArray, volume: NDArray, length: int = 20) -> NDArray:
    out = np.full_like(close, np.nan, dtype=np.float64)
    if len(close) < length:
        return out
    for i in range(length - 1, len(close)):
        c = close[i - length + 1 : i + 1]
        v = volume[i - length + 1 : i + 1]
        total_v = float(np.sum(v))
        if total_v > 0:
            out[i] = float(np.sum(c * v) / total_v)
    return out


def _ma_signal(price: float, value: float) -> int:
    if not np.isfinite(value):
        return 0
    if price > value:
        return 1
    if price < value:
        return -1
    return 0


def _adx_components(high: NDArray, low: NDArray, close: NDArray, length: int = 14):
    n = len(close)
    plus_di = np.full(n, np.nan, dtype=np.float64)
    minus_di = np.full(n, np.nan, dtype=np.float64)
    adx = np.full(n, np.nan, dtype=np.float64)
    if n <= length * 2:
        return adx, plus_di, minus_di

    up = np.diff(high)
    down = -np.diff(low)
    plus_dm = np.where((up > down) & (up > 0), up, 0.0)
    minus_dm = np.where((down > up) & (down > 0), down, 0.0)

    prev_close = np.roll(close, 1)
    prev_close[0] = close[0]
    tr = np.maximum(high - low, np.maximum(np.abs(high - prev_close), np.abs(low - prev_close)))

    sm_tr = float(np.sum(tr[1 : length + 1]))
    sm_plus = float(np.sum(plus_dm[:length]))
    sm_minus = float(np.sum(minus_dm[:length]))

    dx = np.full(n, np.nan, dtype=np.float64)
    for i in range(length, n):
        if i > length:
            sm_tr = sm_tr - sm_tr / length + float(tr[i])
            sm_plus = sm_plus - sm_plus / length + float(plus_dm[i - 1])
            sm_minus = sm_minus - sm_minus / length + float(minus_dm[i - 1])
        if sm_tr <= 0:
            continue
        plus_di[i] = 100.0 * sm_plus / sm_tr
        minus_di[i] = 100.0 * sm_minus / sm_tr
        denom = plus_di[i] + minus_di[i]
        if denom > 0:
            dx[i] = 100.0 * abs(plus_di[i] - minus_di[i]) / denom

    first = length * 2 - 1
    seed = dx[length:first + 1]
    seed = seed[np.isfinite(seed)]
    if len(seed) >= length:
        adx[first] = float(np.mean(seed[-length:]))
        for i in range(first + 1, n):
            if np.isfinite(dx[i]):
                adx[i] = ((adx[i - 1] * (length - 1)) + dx[i]) / length
    return adx, plus_di, minus_di


def _stoch_rsi(rsi_values: NDArray, length: int = 14) -> NDArray:
    out = np.full_like(rsi_values, np.nan, dtype=np.float64)
    for i in range(length - 1, len(rsi_values)):
        window = rsi_values[i - length + 1 : i + 1]
        if not np.all(np.isfinite(window)):
            continue
        lo = float(np.min(window))
        hi = float(np.max(window))
        out[i] = 50.0 if hi == lo else 100.0 * (rsi_values[i] - lo) / (hi - lo)
    return out


def technical_rating_approx(
    open_arr: NDArray,
    high: NDArray,
    low: NDArray,
    close: NDArray,
    volume: NDArray,
) -> dict:
    """Return a local 15-MA + 11-oscillator rating with explicit approximation metadata."""
    del open_arr
    n = len(close)
    if n < 210:
        return {
            "method": "tradingview_style_approx_v2",
            "ma_rating": 0.0,
            "osc_rating": 0.0,
            "overall_rating": 0.0,
            "ma_signals": {},
            "osc_signals": {},
            "insufficient_history": True,
        }

    i = n - 1
    prev = i - 1
    ma_signals: dict[str, int] = {}
    osc_signals: dict[str, int] = {}

    for kind, fn in (("EMA", ema), ("SMA", sma)):
        for length in (10, 20, 30, 50, 100, 200):
            series = fn(close, length)
            ma_signals[f"{kind}{length}"] = _ma_signal(float(close[i]), float(series[i]))

    hull9 = hma(close, 9)
    ma_signals["HullMA9"] = _ma_signal(float(close[i]), float(hull9[i]))

    vwma20 = vwma(close, volume, 20)
    ma_signals["VWMA20"] = _ma_signal(float(close[i]), float(vwma20[i]))

    # Ichimoku base line (Kijun-sen, 26 periods) as the MA-style comparison.
    kijun = (float(np.max(high[i - 25 : i + 1])) + float(np.min(low[i - 25 : i + 1]))) / 2.0
    ma_signals["IchimokuBase"] = _ma_signal(float(close[i]), kijun)

    r = rsi(close, 14)
    if np.isfinite(r[i]) and np.isfinite(r[prev]):
        osc_signals["RSI"] = 1 if r[i] < 30 and r[i] > r[prev] else (-1 if r[i] > 70 and r[i] < r[prev] else 0)
    else:
        osc_signals["RSI"] = 0

    k, d = stochastic(high, low, close, 14, 3)
    if np.isfinite(k[i]) and np.isfinite(d[i]) and np.isfinite(k[prev]):
        osc_signals["Stoch"] = 1 if k[i] < 20 and k[i] > d[i] and k[i] > k[prev] else (-1 if k[i] > 80 and k[i] < d[i] and k[i] < k[prev] else 0)
    else:
        osc_signals["Stoch"] = 0

    cci20 = cci(high, low, close, 20)
    if np.isfinite(cci20[i]) and np.isfinite(cci20[prev]):
        osc_signals["CCI"] = 1 if cci20[i] < -100 and cci20[i] > cci20[prev] else (-1 if cci20[i] > 100 and cci20[i] < cci20[prev] else 0)
    else:
        osc_signals["CCI"] = 0

    adx14, plus_di, minus_di = _adx_components(high, low, close, 14)
    if all(np.isfinite(x) for x in (adx14[i], plus_di[i], minus_di[i], plus_di[prev], minus_di[prev])) and adx14[i] > 20:
        if plus_di[i] > minus_di[i] and plus_di[i] > plus_di[prev]:
            osc_signals["ADX"] = 1
        elif minus_di[i] > plus_di[i] and minus_di[i] > minus_di[prev]:
            osc_signals["ADX"] = -1
        else:
            osc_signals["ADX"] = 0
    else:
        osc_signals["ADX"] = 0

    ao = awesome_oscillator(high, low)
    osc_signals["AO"] = 1 if np.isfinite(ao[i]) and np.isfinite(ao[prev]) and ao[i] > ao[prev] else (-1 if np.isfinite(ao[i]) and np.isfinite(ao[prev]) and ao[i] < ao[prev] else 0)

    mom = momentum(close, 10)
    osc_signals["Momentum"] = 1 if np.isfinite(mom[i]) and mom[i] > 0 else (-1 if np.isfinite(mom[i]) and mom[i] < 0 else 0)

    macd_line, signal_line, _ = macd(close, 12, 26, 9)
    if np.isfinite(macd_line[i]) and np.isfinite(signal_line[i]):
        osc_signals["MACD"] = 1 if macd_line[i] > signal_line[i] else (-1 if macd_line[i] < signal_line[i] else 0)
    else:
        osc_signals["MACD"] = 0

    srsi = _stoch_rsi(r, 14)
    if np.isfinite(srsi[i]) and np.isfinite(srsi[prev]):
        osc_signals["StochRSI"] = 1 if srsi[i] < 20 and srsi[i] > srsi[prev] else (-1 if srsi[i] > 80 and srsi[i] < srsi[prev] else 0)
    else:
        osc_signals["StochRSI"] = 0

    wr = williams_r(high, low, close, 14)
    if np.isfinite(wr[i]) and np.isfinite(wr[prev]):
        osc_signals["WilliamsR"] = 1 if wr[i] < -80 and wr[i] > wr[prev] else (-1 if wr[i] > -20 and wr[i] < wr[prev] else 0)
    else:
        osc_signals["WilliamsR"] = 0

    ema13 = ema(close, 13)
    bull = high - ema13
    bear = low - ema13
    if all(np.isfinite(x) for x in (bull[i], bear[i], bull[prev], bear[prev])):
        osc_signals["BullBear"] = 1 if bull[i] > 0 and bear[i] > bear[prev] else (-1 if bear[i] < 0 and bull[i] < bull[prev] else 0)
    else:
        osc_signals["BullBear"] = 0

    uo = ultimate_oscillator(high, low, close)
    if np.isfinite(uo[i]) and np.isfinite(uo[prev]):
        osc_signals["Ultimate"] = 1 if uo[i] < 30 and uo[i] > uo[prev] else (-1 if uo[i] > 70 and uo[i] < uo[prev] else 0)
    else:
        osc_signals["Ultimate"] = 0

    ma_rating = float(np.mean(list(ma_signals.values())))
    osc_rating = float(np.mean(list(osc_signals.values())))
    all_signals = list(ma_signals.values()) + list(osc_signals.values())
    overall_rating = float(np.mean(all_signals))

    return {
        "method": "tradingview_style_approx_v2",
        "ma_rating": round(ma_rating, 4),
        "osc_rating": round(osc_rating, 4),
        "overall_rating": round(overall_rating, 4),
        "ma_signals": ma_signals,
        "osc_signals": osc_signals,
        "insufficient_history": False,
    }
