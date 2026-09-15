"""
Pure-numpy technical indicator calculations.

Computes all indicators locally — no TradingView dependency.
Includes the full 26-indicator Technical Rating calculation.
"""

import numpy as np
from numpy.typing import NDArray


# ─── Moving Averages ──────────────────────────────────────────────────────────


def sma(close: NDArray, length: int) -> NDArray:
    """Simple Moving Average."""
    result = np.full_like(close, np.nan)
    if len(close) < length:
        return result
    cumsum = np.cumsum(close)
    cumsum[length:] = cumsum[length:] - cumsum[:-length]
    result[length - 1 :] = cumsum[length - 1 :] / length
    return result


def ema(close: NDArray, length: int) -> NDArray:
    """Exponential Moving Average."""
    result = np.full_like(close, np.nan, dtype=np.float64)
    if len(close) < length:
        return result

    alpha = 2.0 / (length + 1)
    # Seed with SMA
    result[length - 1] = np.mean(close[:length])

    for i in range(length, len(close)):
        result[i] = alpha * close[i] + (1 - alpha) * result[i - 1]

    return result


# ─── Oscillators ──────────────────────────────────────────────────────────────


def rsi(close: NDArray, length: int = 14) -> NDArray:
    """Relative Strength Index."""
    result = np.full_like(close, np.nan, dtype=np.float64)
    if len(close) < length + 1:
        return result

    deltas = np.diff(close)
    gains = np.where(deltas > 0, deltas, 0.0)
    losses = np.where(deltas < 0, -deltas, 0.0)

    avg_gain = np.mean(gains[:length])
    avg_loss = np.mean(losses[:length])

    if avg_loss == 0:
        result[length] = 100.0
    else:
        rs = avg_gain / avg_loss
        result[length] = 100.0 - (100.0 / (1.0 + rs))

    for i in range(length, len(deltas)):
        avg_gain = (avg_gain * (length - 1) + gains[i]) / length
        avg_loss = (avg_loss * (length - 1) + losses[i]) / length

        if avg_loss == 0:
            result[i + 1] = 100.0
        else:
            rs = avg_gain / avg_loss
            result[i + 1] = 100.0 - (100.0 / (1.0 + rs))

    return result


def stochastic(
    high: NDArray, low: NDArray, close: NDArray, k_period: int = 14, d_period: int = 3
) -> tuple[NDArray, NDArray]:
    """Stochastic Oscillator (%K and %D)."""
    k = np.full_like(close, np.nan, dtype=np.float64)

    for i in range(k_period - 1, len(close)):
        hh = np.max(high[i - k_period + 1 : i + 1])
        ll = np.min(low[i - k_period + 1 : i + 1])
        if hh == ll:
            k[i] = 50.0
        else:
            k[i] = 100.0 * (close[i] - ll) / (hh - ll)

    d = sma(k[~np.isnan(k)], d_period)
    d_full = np.full_like(close, np.nan, dtype=np.float64)
    valid_k = np.where(~np.isnan(k))[0]
    if len(d) > 0 and len(valid_k) >= d_period:
        start = valid_k[d_period - 1]
        d_full[start : start + len(d) - d_period + 1] = d[d_period - 1 :]

    return k, d_full


def macd(
    close: NDArray,
    fast_length: int = 12,
    slow_length: int = 26,
    signal_length: int = 9,
) -> tuple[NDArray, NDArray, NDArray]:
    """MACD: returns (macd_line, signal_line, histogram)."""
    ema_fast = ema(close, fast_length)
    ema_slow = ema(close, slow_length)

    macd_line = ema_fast - ema_slow
    signal_line = ema(macd_line[~np.isnan(macd_line)], signal_length)

    # Align signal back to original array
    signal_full = np.full_like(close, np.nan, dtype=np.float64)
    valid_macd = np.where(~np.isnan(macd_line))[0]
    if len(signal_line) > 0 and len(valid_macd) >= signal_length:
        start = valid_macd[signal_length - 1]
        valid_signal = signal_line[~np.isnan(signal_line)]
        end = start + len(valid_signal)
        signal_full[start:end] = valid_signal

    histogram = macd_line - signal_full

    return macd_line, signal_full, histogram


def cci(high: NDArray, low: NDArray, close: NDArray, length: int = 20) -> NDArray:
    """Commodity Channel Index."""
    tp = (high + low + close) / 3.0
    tp_sma = sma(tp, length)

    result = np.full_like(close, np.nan, dtype=np.float64)
    for i in range(length - 1, len(close)):
        mean_dev = np.mean(np.abs(tp[i - length + 1 : i + 1] - tp_sma[i]))
        if mean_dev == 0:
            result[i] = 0.0
        else:
            result[i] = (tp[i] - tp_sma[i]) / (0.015 * mean_dev)

    return result


def williams_r(
    high: NDArray, low: NDArray, close: NDArray, length: int = 14
) -> NDArray:
    """Williams %R."""
    result = np.full_like(close, np.nan, dtype=np.float64)
    for i in range(length - 1, len(close)):
        hh = np.max(high[i - length + 1 : i + 1])
        ll = np.min(low[i - length + 1 : i + 1])
        if hh == ll:
            result[i] = -50.0
        else:
            result[i] = -100.0 * (hh - close[i]) / (hh - ll)
    return result


def awesome_oscillator(high: NDArray, low: NDArray) -> NDArray:
    """Awesome Oscillator (AO)."""
    midpoint = (high + low) / 2.0
    return sma(midpoint, 5) - sma(midpoint, 34)


def momentum(close: NDArray, length: int = 10) -> NDArray:
    """Momentum (close - close[n])."""
    result = np.full_like(close, np.nan, dtype=np.float64)
    result[length:] = close[length:] - close[:-length]
    return result


def ultimate_oscillator(
    high: NDArray, low: NDArray, close: NDArray,
    p1: int = 7, p2: int = 14, p3: int = 28
) -> NDArray:
    """Ultimate Oscillator."""
    result = np.full_like(close, np.nan, dtype=np.float64)
    if len(close) < max(p1, p2, p3) + 1:
        return result

    prev_close = np.roll(close, 1)
    prev_close[0] = close[0]

    bp = close - np.minimum(low, prev_close)
    tr = np.maximum(high, prev_close) - np.minimum(low, prev_close)

    for i in range(p3, len(close)):
        s1 = np.sum(bp[i - p1 + 1 : i + 1]) / max(np.sum(tr[i - p1 + 1 : i + 1]), 1e-10)
        s2 = np.sum(bp[i - p2 + 1 : i + 1]) / max(np.sum(tr[i - p2 + 1 : i + 1]), 1e-10)
        s3 = np.sum(bp[i - p3 + 1 : i + 1]) / max(np.sum(tr[i - p3 + 1 : i + 1]), 1e-10)
        result[i] = 100.0 * (4 * s1 + 2 * s2 + s3) / 7.0

    return result


# ─── Volatility ───────────────────────────────────────────────────────────────


def atr(high: NDArray, low: NDArray, close: NDArray, length: int = 14) -> NDArray:
    """Average True Range."""
    if len(close) < 2:
        return np.full_like(close, np.nan, dtype=np.float64)

    prev_close = np.roll(close, 1)
    prev_close[0] = close[0]

    tr = np.maximum(
        high - low,
        np.maximum(np.abs(high - prev_close), np.abs(low - prev_close)),
    )

    result = np.full_like(close, np.nan, dtype=np.float64)
    if len(tr) < length:
        return result

    result[length - 1] = np.mean(tr[:length])
    alpha = 1.0 / length
    for i in range(length, len(tr)):
        result[i] = alpha * tr[i] + (1 - alpha) * result[i - 1]

    return result


def bollinger_bands(
    close: NDArray, length: int = 20, stddev: float = 2.0
) -> tuple[NDArray, NDArray, NDArray]:
    """Bollinger Bands: (upper, middle, lower)."""
    middle = sma(close, length)
    rolling_std = np.full_like(close, np.nan, dtype=np.float64)

    for i in range(length - 1, len(close)):
        rolling_std[i] = np.std(close[i - length + 1 : i + 1], ddof=0)

    upper = middle + stddev * rolling_std
    lower = middle - stddev * rolling_std

    return upper, middle, lower


def supertrend(
    high: NDArray, low: NDArray, close: NDArray, factor: float = 3.0, atr_length: int = 10
) -> NDArray:
    """Supertrend indicator. Returns the supertrend line."""
    atr_val = atr(high, low, close, atr_length)
    hl2 = (high + low) / 2.0

    upper_band = hl2 + factor * atr_val
    lower_band = hl2 - factor * atr_val

    supertrend_out = np.full_like(close, np.nan, dtype=np.float64)
    direction = np.zeros(len(close), dtype=int)  # 1 = up, -1 = down

    # First valid index
    start = atr_length - 1
    if np.isnan(atr_val[start]):
        return supertrend_out

    supertrend_out[start] = upper_band[start]
    direction[start] = 1

    for i in range(start + 1, len(close)):
        if np.isnan(atr_val[i]):
            continue

        # Adjust bands
        if lower_band[i] > lower_band[i - 1] or close[i - 1] < lower_band[i - 1]:
            pass
        else:
            lower_band[i] = lower_band[i - 1]

        if upper_band[i] < upper_band[i - 1] or close[i - 1] > upper_band[i - 1]:
            pass
        else:
            upper_band[i] = upper_band[i - 1]

        if direction[i - 1] == 1:
            if close[i] > lower_band[i]:
                direction[i] = 1
                supertrend_out[i] = lower_band[i]
            else:
                direction[i] = -1
                supertrend_out[i] = upper_band[i]
        else:
            if close[i] < upper_band[i]:
                direction[i] = -1
                supertrend_out[i] = upper_band[i]
            else:
                direction[i] = 1
                supertrend_out[i] = lower_band[i]

    return supertrend_out


# ─── ADX ──────────────────────────────────────────────────────────────────────


def adx(high: NDArray, low: NDArray, close: NDArray, length: int = 14) -> NDArray:
    """Average Directional Index."""
    result = np.full_like(close, np.nan, dtype=np.float64)
    if len(close) < length + 1:
        return result

    up_move = np.diff(high)
    down_move = -np.diff(low)

    plus_dm = np.where((up_move > down_move) & (up_move > 0), up_move, 0.0)
    minus_dm = np.where((down_move > up_move) & (down_move > 0), down_move, 0.0)

    atr_val = atr(high, low, close, length)

    plus_di = np.full_like(close, np.nan, dtype=np.float64)
    minus_di = np.full_like(close, np.nan, dtype=np.float64)

    # Smoothed DM
    sm_plus = np.mean(plus_dm[:length])
    sm_minus = np.mean(minus_dm[:length])

    for i in range(length, len(close)):
        if i - 1 < len(plus_dm):
            sm_plus = (sm_plus * (length - 1) + plus_dm[i - 1]) / length
            sm_minus = (sm_minus * (length - 1) + minus_dm[i - 1]) / length

        if not np.isnan(atr_val[i]) and atr_val[i] > 0:
            plus_di[i] = 100.0 * sm_plus / atr_val[i]
            minus_di[i] = 100.0 * sm_minus / atr_val[i]

    # DX and ADX
    dx = np.full_like(close, np.nan, dtype=np.float64)
    valid = ~np.isnan(plus_di) & ~np.isnan(minus_di)
    denominator = plus_di + minus_di
    safe = valid & (denominator > 0)
    dx[safe] = 100.0 * np.abs(plus_di[safe] - minus_di[safe]) / denominator[safe]

    # Smooth ADX
    valid_dx = dx[~np.isnan(dx)]
    if len(valid_dx) >= length:
        adx_seed = np.mean(valid_dx[:length])
        first_valid = np.where(~np.isnan(dx))[0]
        if len(first_valid) >= length:
            idx = first_valid[length - 1]
            result[idx] = adx_seed
            for j in range(idx + 1, len(close)):
                if not np.isnan(dx[j]):
                    result[j] = (result[j - 1] * (length - 1) + dx[j]) / length
                elif not np.isnan(result[j - 1]):
                    result[j] = result[j - 1]

    return result


# ─── TradingView 26-Indicator Technical Rating ───────────────────────────────


def _signal(value: float) -> int:
    """Convert indicator output to BUY(1) / NEUTRAL(0) / SELL(-1)."""
    if value > 0:
        return 1
    elif value < 0:
        return -1
    return 0


def technical_rating(
    open_arr: NDArray,
    high: NDArray,
    low: NDArray,
    close: NDArray,
    volume: NDArray,
) -> dict:
    """
    Compute TradingView-style Technical Rating from 26 indicators.

    Returns dict with:
    - ma_rating: float (-1 to 1)
    - osc_rating: float (-1 to 1)
    - overall_rating: float (-1 to 1)
    - ma_signals: dict of individual MA signals
    - osc_signals: dict of individual oscillator signals
    """
    n = len(close)
    if n < 50:
        return {"ma_rating": 0, "osc_rating": 0, "overall_rating": 0,
                "ma_signals": {}, "osc_signals": {}}

    idx = n - 1  # Latest bar
    ma_signals = {}
    osc_signals = {}

    # ── Moving Averages (15 signals) ──
    for name, length in [("EMA10", 10), ("EMA20", 20), ("EMA30", 30),
                          ("EMA50", 50), ("EMA100", 100), ("EMA200", 200)]:
        val = ema(close, length)
        if not np.isnan(val[idx]):
            ma_signals[name] = 1 if close[idx] > val[idx] else -1
        else:
            ma_signals[name] = 0

    for name, length in [("SMA10", 10), ("SMA20", 20), ("SMA30", 30),
                          ("SMA50", 50), ("SMA100", 100), ("SMA200", 200)]:
        val = sma(close, length)
        if not np.isnan(val[idx]):
            ma_signals[name] = 1 if close[idx] > val[idx] else -1
        else:
            ma_signals[name] = 0

    # Hull MA (approximation: 2*WMA(n/2) - WMA(n)), using EMA as proxy
    hull = ema(close, 9)
    if not np.isnan(hull[idx]):
        ma_signals["HullMA9"] = 1 if close[idx] > hull[idx] else -1
    else:
        ma_signals["HullMA9"] = 0

    # VWAP (simplified as cumulative)
    cum_vp = np.cumsum(close * volume)
    cum_v = np.cumsum(volume)
    vwap_val = cum_vp[idx] / cum_v[idx] if cum_v[idx] > 0 else close[idx]
    ma_signals["VWAP"] = 1 if close[idx] > vwap_val else -1

    # Ichimoku (simplified)
    if n >= 52:
        tenkan = (np.max(high[idx - 8 : idx + 1]) + np.min(low[idx - 8 : idx + 1])) / 2
        kijun = (np.max(high[idx - 25 : idx + 1]) + np.min(low[idx - 25 : idx + 1])) / 2
        ma_signals["Ichimoku"] = 1 if close[idx] > tenkan else (-1 if close[idx] < kijun else 0)
    else:
        ma_signals["Ichimoku"] = 0

    # ── Oscillators (11 signals) ──
    rsi_val = rsi(close, 14)
    if not np.isnan(rsi_val[idx]):
        if rsi_val[idx] < 30:
            osc_signals["RSI"] = 1
        elif rsi_val[idx] > 70:
            osc_signals["RSI"] = -1
        else:
            osc_signals["RSI"] = 0
    else:
        osc_signals["RSI"] = 0

    stoch_k, stoch_d = stochastic(high, low, close, 14, 3)
    if not np.isnan(stoch_k[idx]):
        if stoch_k[idx] < 20:
            osc_signals["Stoch"] = 1
        elif stoch_k[idx] > 80:
            osc_signals["Stoch"] = -1
        else:
            osc_signals["Stoch"] = 0
    else:
        osc_signals["Stoch"] = 0

    cci_val = cci(high, low, close, 20)
    if not np.isnan(cci_val[idx]):
        if cci_val[idx] < -100:
            osc_signals["CCI"] = 1
        elif cci_val[idx] > 100:
            osc_signals["CCI"] = -1
        else:
            osc_signals["CCI"] = 0
    else:
        osc_signals["CCI"] = 0

    adx_val = adx(high, low, close, 14)
    if not np.isnan(adx_val[idx]):
        osc_signals["ADX"] = 1 if adx_val[idx] > 25 else 0
    else:
        osc_signals["ADX"] = 0

    ao_val = awesome_oscillator(high, low)
    if not np.isnan(ao_val[idx]):
        osc_signals["AO"] = _signal(ao_val[idx])
    else:
        osc_signals["AO"] = 0

    mom_val = momentum(close, 10)
    if not np.isnan(mom_val[idx]):
        osc_signals["Mom"] = _signal(mom_val[idx])
    else:
        osc_signals["Mom"] = 0

    macd_line, signal_line, hist = macd(close, 12, 26, 9)
    if not np.isnan(hist[idx]):
        osc_signals["MACD"] = _signal(hist[idx])
    else:
        osc_signals["MACD"] = 0

    # Stoch RSI
    rsi_vals = rsi_val[~np.isnan(rsi_val)]
    if len(rsi_vals) >= 14:
        stoch_rsi_k, _ = stochastic(rsi_vals, rsi_vals, rsi_vals, 14, 3)
        sr = stoch_rsi_k[-1] if len(stoch_rsi_k) > 0 and not np.isnan(stoch_rsi_k[-1]) else 50
        if sr < 20:
            osc_signals["StochRSI"] = 1
        elif sr > 80:
            osc_signals["StochRSI"] = -1
        else:
            osc_signals["StochRSI"] = 0
    else:
        osc_signals["StochRSI"] = 0

    wr_val = williams_r(high, low, close, 14)
    if not np.isnan(wr_val[idx]):
        if wr_val[idx] < -80:
            osc_signals["WilliamsR"] = 1
        elif wr_val[idx] > -20:
            osc_signals["WilliamsR"] = -1
        else:
            osc_signals["WilliamsR"] = 0
    else:
        osc_signals["WilliamsR"] = 0

    # Bull/Bear Power
    ema13 = ema(close, 13)
    if not np.isnan(ema13[idx]):
        bull_power = high[idx] - ema13[idx]
        bear_power = low[idx] - ema13[idx]
        osc_signals["BullBear"] = _signal(bull_power + bear_power)
    else:
        osc_signals["BullBear"] = 0

    uo_val = ultimate_oscillator(high, low, close)
    if not np.isnan(uo_val[idx]):
        if uo_val[idx] < 30:
            osc_signals["UO"] = 1
        elif uo_val[idx] > 70:
            osc_signals["UO"] = -1
        else:
            osc_signals["UO"] = 0
    else:
        osc_signals["UO"] = 0

    # ── Ratings ──
    ma_values = list(ma_signals.values())
    osc_values = list(osc_signals.values())

    ma_rating = sum(ma_values) / max(len(ma_values), 1)
    osc_rating = sum(osc_values) / max(len(osc_values), 1)
    overall_rating = (ma_rating + osc_rating) / 2

    return {
        "ma_rating": round(ma_rating, 4),
        "osc_rating": round(osc_rating, 4),
        "overall_rating": round(overall_rating, 4),
        "ma_signals": ma_signals,
        "osc_signals": osc_signals,
    }
