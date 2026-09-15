import numpy as np

from src.scanners.anomaly_scanner import compute_z_scores, scan_ohlcv


def test_z_score_uses_prior_window_only():
    values = np.array([1.0, 2.0, 1.0, 2.0, 10.0])
    z = compute_z_scores(values, 3)
    # At index 4 the baseline is [2, 1, 2], not a window containing the 10 itself.
    assert z[4] > 10


def test_volume_spike_emits_candidate():
    n = 40
    ts = np.array([1_700_000_000_000 + i * 900_000 for i in range(n)], dtype=np.int64)
    close = np.linspace(100, 101, n)
    open_arr = close.copy()
    high = close + 0.5
    low = close - 0.5
    volume = np.array([100 + (i % 3) * 3 for i in range(n)], dtype=float)
    volume[-1] = 1000.0

    events = scan_ohlcv(
        "BTCUSDT",
        ts,
        open_arr,
        high,
        low,
        close,
        volume,
        z_threshold=3.0,
        lookback_window=10,
    )

    assert any(e.event_type == "VOLUME_ANOMALY" and e.timestamp == ts[-1] for e in events)
