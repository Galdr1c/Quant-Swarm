import numpy as np

from src.backtest import engine


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
