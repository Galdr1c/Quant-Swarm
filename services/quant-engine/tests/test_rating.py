import numpy as np

from src.indicators.rating import technical_rating_approx


def test_rating_is_explicit_approximation_with_26_signals():
    n = 260
    close = np.linspace(100.0, 130.0, n) + np.sin(np.linspace(0, 20, n))
    open_arr = close - 0.1
    high = close + 0.8
    low = close - 0.8
    volume = np.linspace(1000.0, 1400.0, n)

    result = technical_rating_approx(open_arr, high, low, close, volume)

    assert result["method"] == "tradingview_style_approx_v2"
    assert len(result["ma_signals"]) == 15
    assert len(result["osc_signals"]) == 11
    assert -1.0 <= result["overall_rating"] <= 1.0
