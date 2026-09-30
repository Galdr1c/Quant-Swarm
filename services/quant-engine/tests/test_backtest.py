import numpy as np
import pytest

from src.backtest import engine
from src.backtest.strategy_runner import compute_indicator, evaluate_rule


def _strategy(risk=None):
    return {
        "id": "test-strategy",
        "risk": {"maxPositionPct": 10, **(risk or {})},
    }


def _bars():
    timestamps = np.array([1_700_000_000_000 + i * 900_000 for i in range(5)], dtype=np.int64)
    open_arr = np.array([100.0, 110.0, 120.0, 121.0, 122.0])
    high = np.array([106.0, 112.0, 122.0, 123.0, 124.0])
    low = np.array([99.0, 109.0, 119.0, 120.0, 121.0])
    close = np.array([105.0, 111.0, 121.0, 122.0, 123.0])
    volume = np.full(5, 1000.0)
    return timestamps, open_arr, high, low, close, volume


def test_signal_executes_on_next_bar_open(monkeypatch):
    entry = np.array([True, False, False, False, False])
    exit_ = np.array([False, True, False, False, False])
    monkeypatch.setattr(engine, "generate_signals", lambda *args, **kwargs: (entry, exit_))

    ts, o, h, l, c, v = _bars()
    result = engine.run_backtest(_strategy(), o, h, l, c, v, ts)

    assert result.total_trades == 1
    trade = result.trades[0]
    assert trade.entry_index == 1
    assert trade.exit_index == 2
    assert trade.entry_price > o[1]  # adverse entry slippage
    assert trade.exit_price < o[2]   # adverse exit slippage


def test_intrabar_stop_uses_low_not_close(monkeypatch):
    entry = np.array([True, False, False])
    exit_ = np.array([False, False, False])
    monkeypatch.setattr(engine, "generate_signals", lambda *args, **kwargs: (entry, exit_))

    ts = np.array([1_700_000_000_000 + i * 900_000 for i in range(3)], dtype=np.int64)
    o = np.array([100.0, 100.0, 101.0])
    h = np.array([101.0, 102.0, 102.0])
    l = np.array([99.0, 94.0, 100.0])
    c = np.array([100.0, 101.0, 101.0])  # close itself never breaches a 5% stop
    v = np.full(3, 1000.0)

    result = engine.run_backtest(_strategy({"stopLossPct": 5.0}), o, h, l, c, v, ts)

    assert result.total_trades == 1
    assert result.trades[0].exit_index == 1
    assert result.trades[0].exit_reason == "stop_loss"
    assert result.trades[0].pnl < 0


def test_equity_curve_is_marked_to_market(monkeypatch):
    entry = np.array([True, False, False, False, False])
    exit_ = np.array([False, False, True, False, False])
    monkeypatch.setattr(engine, "generate_signals", lambda *args, **kwargs: (entry, exit_))

    ts, o, h, l, c, v = _bars()
    # Force a marked loss while the trade is still open.
    c[1] = 90.0
    l[1] = 89.0
    result = engine.run_backtest(_strategy(), o, h, l, c, v, ts)

    assert len(result.equity_curve) == len(c)
    assert result.equity_curve[1] < 100_000
    assert result.max_drawdown > 0
    assert result.fees_paid > 0
    assert result.slippage_paid > 0


def test_annualization_is_inferred_from_hourly_timestamps(monkeypatch):
    entry = np.array([True, False, False, False, False])
    exit_ = np.array([False, True, False, False, False])
    monkeypatch.setattr(engine, "generate_signals", lambda *args, **kwargs: (entry, exit_))

    _, o, h, l, c, v = _bars()
    ts = np.array([1_700_000_000_000 + i * 3_600_000 for i in range(5)], dtype=np.int64)
    result = engine.run_backtest(_strategy(), o, h, l, c, v, ts)

    assert result.annualization == pytest.approx(365.25 * 24, rel=1e-6)


def test_undefined_indicator_reference_fails_closed():
    close = np.array([100.0, 101.0, 102.0])
    with pytest.raises(ValueError, match="undefined indicator"):
        evaluate_rule(
            {"left": "missing", "operator": ">", "right": 50},
            {},
            close,
        )


def test_macd_and_bbands_components_are_explicit_series():
    n = 80
    close = np.linspace(100.0, 120.0, n) + np.sin(np.arange(n) / 3.0)
    open_arr = close - 0.2
    high = close + 0.8
    low = close - 0.8
    volume = np.full(n, 1_000.0)
    timestamps = np.array(
        [1_700_000_000_000 + i * 3_600_000 for i in range(n)],
        dtype=np.int64,
    )

    macd_line = compute_indicator(
        {
            "type": "MACD",
            "params": {
                "fastLength": 12,
                "slowLength": 26,
                "signalLength": 9,
                "component": "line",
            },
        },
        open_arr,
        high,
        low,
        close,
        volume,
        timestamps,
    )
    macd_hist = compute_indicator(
        {
            "type": "MACD",
            "params": {
                "fastLength": 12,
                "slowLength": 26,
                "signalLength": 9,
                "component": "histogram",
            },
        },
        open_arr,
        high,
        low,
        close,
        volume,
        timestamps,
    )
    upper = compute_indicator(
        {"type": "BBANDS", "params": {"length": 20, "stddev": 2, "component": "upper"}},
        open_arr,
        high,
        low,
        close,
        volume,
        timestamps,
    )
    lower = compute_indicator(
        {"type": "BBANDS", "params": {"length": 20, "stddev": 2, "component": "lower"}},
        open_arr,
        high,
        low,
        close,
        volume,
        timestamps,
    )

    valid_macd = ~np.isnan(macd_line) & ~np.isnan(macd_hist)
    valid_bands = ~np.isnan(upper) & ~np.isnan(lower)
    assert np.any(valid_macd)
    assert not np.allclose(macd_line[valid_macd], macd_hist[valid_macd])
    assert np.all(upper[valid_bands] >= lower[valid_bands])


def test_vwap_utc_day_resets_at_day_boundary():
    day_ms = 86_400_000
    day0 = 1_704_067_200_000  # 2024-01-01T00:00:00Z
    timestamps = np.array(
        [
            day0,
            day0 + 3_600_000,
            day0 + 2 * 3_600_000,
            day0 + day_ms,
            day0 + day_ms + 3_600_000,
        ],
        dtype=np.int64,
    )
    close = np.array([100.0, 110.0, 120.0, 200.0, 220.0])
    open_arr = close.copy()
    high = close + 1.0
    low = close - 1.0
    volume = np.array([1.0, 1.0, 2.0, 3.0, 1.0])

    continuous = compute_indicator(
        {"type": "VWAP", "params": {"source": "close", "reset": "continuous"}},
        open_arr,
        high,
        low,
        close,
        volume,
        timestamps,
    )
    daily = compute_indicator(
        {"type": "VWAP", "params": {"source": "close", "reset": "utc_day"}},
        open_arr,
        high,
        low,
        close,
        volume,
        timestamps,
    )

    assert daily[0] == pytest.approx(100.0)
    assert daily[2] == pytest.approx((100 + 110 + 240) / 4)
    assert daily[3] == pytest.approx(200.0)
    assert daily[4] == pytest.approx((200 * 3 + 220) / 4)
    assert daily[3] != pytest.approx(continuous[3])


def test_vwap_utc_day_requires_timestamps():
    close = np.array([100.0, 101.0, 102.0])
    with pytest.raises(ValueError, match="requires candle timestamps"):
        compute_indicator(
            {"type": "VWAP", "params": {"reset": "utc_day"}},
            close,
            close,
            close,
            close,
            np.ones(3),
        )


def test_backtest_rejects_non_monotonic_timestamps():
    ts, o, h, l, c, v = _bars()
    ts[2] = ts[1]
    with pytest.raises(ValueError, match="strictly increasing"):
        engine.run_backtest(_strategy(), o, h, l, c, v, ts)
