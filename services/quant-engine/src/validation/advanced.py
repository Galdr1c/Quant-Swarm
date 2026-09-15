"""Advanced deterministic research-validation primitives.

These functions are deliberately independent of any LLM. They implement
statistical evidence checks that become important when many strategy variants
are searched and only the best backtests are surfaced.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations
import math
from typing import Iterable

import numpy as np
from numpy.typing import NDArray
from scipy.stats import kurtosis, norm, skew


@dataclass(frozen=True)
class TimeSeriesSplit:
    train_indices: list[int]
    test_indices: list[int]


@dataclass(frozen=True)
class MultipleTestingResult:
    rejected: list[bool]
    q_values: list[float]
    alpha: float


@dataclass(frozen=True)
class PBOResult:
    probability: float
    logits: list[float]
    combinations_evaluated: int


def equity_returns(equity_curve: Iterable[float]) -> NDArray[np.float64]:
    """Convert an equity curve to finite simple returns."""
    equity = np.asarray(list(equity_curve), dtype=np.float64)
    if equity.size < 2:
        return np.asarray([], dtype=np.float64)
    previous = equity[:-1]
    current = equity[1:]
    mask = np.isfinite(previous) & np.isfinite(current) & (previous != 0)
    returns = (current[mask] - previous[mask]) / previous[mask]
    return returns[np.isfinite(returns)]


def sharpe_ratio(returns: Iterable[float], annualization: float = 1.0) -> float:
    values = _finite_array(returns)
    if values.size < 2:
        return 0.0
    std = float(np.std(values, ddof=1))
    if std <= 1e-15:
        return 0.0
    return float(np.mean(values) / std * math.sqrt(max(annualization, 1e-12)))


def probabilistic_sharpe_ratio(
    returns: Iterable[float],
    benchmark_sharpe: float = 0.0,
    annualization: float = 1.0,
) -> float:
    """Probability that the true Sharpe exceeds ``benchmark_sharpe``.

    The computation follows the skew/kurtosis-adjusted Probabilistic Sharpe
    Ratio used as the probability component of the Deflated Sharpe Ratio.
    Sharpe inputs are normalized to the observation frequency before applying
    the finite-sample statistic.
    """
    values = _finite_array(returns)
    n = values.size
    if n < 3:
        return float("nan")

    annualization = max(float(annualization), 1e-12)
    observed_annual = sharpe_ratio(values, annualization)
    observed = observed_annual / math.sqrt(annualization)
    benchmark = float(benchmark_sharpe) / math.sqrt(annualization)
    sample_skew = float(skew(values, bias=False)) if n >= 3 else 0.0
    # Pearson kurtosis (normal == 3), matching the PSR denominator.
    sample_kurtosis = float(kurtosis(values, fisher=False, bias=False)) if n >= 4 else 3.0
    if not math.isfinite(sample_skew):
        sample_skew = 0.0
    if not math.isfinite(sample_kurtosis):
        sample_kurtosis = 3.0

    denominator_sq = (
        1.0
        - sample_skew * observed
        + ((sample_kurtosis - 1.0) / 4.0) * observed * observed
    )
    if denominator_sq <= 0 or not math.isfinite(denominator_sq):
        return float("nan")

    statistic = (
        (observed - benchmark)
        * math.sqrt(n - 1.0)
        / math.sqrt(denominator_sq)
    )
    return float(norm.cdf(statistic))


def expected_max_sharpe(
    trial_sharpes: Iterable[float],
) -> float:
    """Expected maximum Sharpe under multiple independent trials.

    Uses the Euler-Mascheroni interpolation approximation described in the
    Deflated Sharpe Ratio literature. The cross-trial standard deviation is the
    scale of the null distribution; the mean is intentionally not added because
    the benchmark represents selection inflation around a zero-alpha null.
    """
    trials = _finite_array(trial_sharpes)
    n_trials = trials.size
    if n_trials <= 1:
        return 0.0
    sigma = float(np.std(trials, ddof=1))
    if sigma <= 1e-15:
        return 0.0

    gamma = 0.5772156649015329
    n = float(n_trials)
    z1 = float(norm.ppf(1.0 - 1.0 / n))
    z2 = float(norm.ppf(1.0 - 1.0 / (n * math.e)))
    return sigma * ((1.0 - gamma) * z1 + gamma * z2)


def deflated_sharpe_ratio(
    returns: Iterable[float],
    trial_sharpes: Iterable[float],
    annualization: float = 1.0,
) -> tuple[float, float]:
    """Return ``(DSR probability, multiple-testing Sharpe benchmark)``."""
    benchmark = expected_max_sharpe(trial_sharpes)
    probability = probabilistic_sharpe_ratio(
        returns,
        benchmark_sharpe=benchmark,
        annualization=annualization,
    )
    return probability, benchmark


def benjamini_hochberg(
    p_values: Iterable[float],
    alpha: float = 0.05,
) -> MultipleTestingResult:
    """Benjamini-Hochberg false-discovery-rate correction."""
    values = np.asarray(list(p_values), dtype=np.float64)
    if values.size == 0:
        return MultipleTestingResult(rejected=[], q_values=[], alpha=float(alpha))
    if not np.all(np.isfinite(values)) or np.any(values < 0) or np.any(values > 1):
        raise ValueError("p_values must be finite values in [0, 1]")
    if not 0 < alpha < 1:
        raise ValueError("alpha must be in (0, 1)")

    m = values.size
    order = np.argsort(values)
    sorted_p = values[order]
    raw_q = sorted_p * m / np.arange(1, m + 1, dtype=np.float64)
    sorted_q = np.minimum.accumulate(raw_q[::-1])[::-1]
    sorted_q = np.clip(sorted_q, 0.0, 1.0)

    q_values = np.empty(m, dtype=np.float64)
    q_values[order] = sorted_q
    rejected = q_values <= alpha
    return MultipleTestingResult(
        rejected=[bool(v) for v in rejected],
        q_values=[float(v) for v in q_values],
        alpha=float(alpha),
    )


def purged_kfold_splits(
    n_samples: int,
    n_splits: int = 5,
    purge: int = 0,
    embargo: int = 0,
) -> list[TimeSeriesSplit]:
    """Build contiguous K-fold splits with purge and embargo gaps.

    Purge removes observations immediately before the test block from training;
    embargo removes observations immediately after it. This is a bar-index
    implementation for fixed-horizon labels. Event-time label intervals can be
    layered on later without changing the validator contract.
    """
    if n_samples < 2:
        raise ValueError("n_samples must be at least 2")
    if n_splits < 2 or n_splits > n_samples:
        raise ValueError("n_splits must be between 2 and n_samples")
    if purge < 0 or embargo < 0:
        raise ValueError("purge and embargo must be non-negative")

    folds = np.array_split(np.arange(n_samples, dtype=np.int64), n_splits)
    splits: list[TimeSeriesSplit] = []
    all_indices = np.arange(n_samples, dtype=np.int64)

    for test in folds:
        test_start = int(test[0])
        test_end = int(test[-1])
        exclusion_start = max(0, test_start - purge)
        exclusion_end = min(n_samples - 1, test_end + embargo)
        train = all_indices[(all_indices < exclusion_start) | (all_indices > exclusion_end)]
        splits.append(
            TimeSeriesSplit(
                train_indices=[int(v) for v in train],
                test_indices=[int(v) for v in test],
            )
        )
    return splits


def cscv_probability_of_backtest_overfitting(
    returns_matrix: Iterable[Iterable[float]],
    n_blocks: int = 8,
    max_combinations: int = 5000,
) -> PBOResult:
    """Estimate PBO with Combinatorially Symmetric Cross-Validation (CSCV).

    Rows are chronological return observations and columns are strategy trials.
    For each symmetric split, the best in-sample strategy is selected and its
    out-of-sample relative rank is converted to a logit. PBO is the fraction of
    selected strategies whose OOS logit is <= 0 (below the median).
    """
    matrix = np.asarray(list(returns_matrix), dtype=np.float64)
    if matrix.ndim != 2:
        raise ValueError("returns_matrix must be a 2D observations x strategies matrix")
    n_obs, n_strategies = matrix.shape
    if n_strategies < 2:
        raise ValueError("PBO requires at least two strategy trials")
    if n_blocks < 4 or n_blocks % 2 != 0:
        raise ValueError("n_blocks must be an even integer >= 4")
    if n_obs < n_blocks * 2:
        raise ValueError("returns_matrix has too few observations for n_blocks")
    if not np.all(np.isfinite(matrix)):
        raise ValueError("returns_matrix must contain only finite values")

    usable = (n_obs // n_blocks) * n_blocks
    matrix = matrix[:usable]
    blocks = np.array_split(np.arange(usable, dtype=np.int64), n_blocks)
    choose = n_blocks // 2
    logits: list[float] = []

    for count, train_block_ids in enumerate(combinations(range(n_blocks), choose)):
        if count >= max_combinations:
            break
        train_set = set(train_block_ids)
        train_idx = np.concatenate([blocks[i] for i in range(n_blocks) if i in train_set])
        test_idx = np.concatenate([blocks[i] for i in range(n_blocks) if i not in train_set])
        train_perf = np.asarray([sharpe_ratio(matrix[train_idx, j]) for j in range(n_strategies)])
        test_perf = np.asarray([sharpe_ratio(matrix[test_idx, j]) for j in range(n_strategies)])
        selected = int(np.argmax(train_perf))

        # Percentile rank in (0, 1), where 1 is best. Mid-rank avoids infinities.
        order = np.argsort(np.argsort(test_perf))
        rank_from_worst = int(order[selected])
        omega = (rank_from_worst + 0.5) / n_strategies
        omega = min(max(omega, 1e-12), 1.0 - 1e-12)
        logits.append(float(math.log(omega / (1.0 - omega))))

    if not logits:
        raise ValueError("no CSCV combinations were evaluated")
    pbo = float(np.mean(np.asarray(logits) <= 0.0))
    return PBOResult(
        probability=pbo,
        logits=logits,
        combinations_evaluated=len(logits),
    )


def regime_robustness(
    regime_returns: dict[str, Iterable[float]],
) -> dict[str, float]:
    """Return per-regime Sharpe plus the fraction of positive-Sharpe regimes."""
    if not regime_returns:
        raise ValueError("regime_returns must not be empty")
    sharpes: dict[str, float] = {}
    for name, values in regime_returns.items():
        arr = _finite_array(values)
        if arr.size < 2:
            raise ValueError(f"regime {name!r} requires at least two returns")
        sharpes[str(name)] = sharpe_ratio(arr)
    positive_fraction = sum(value > 0 for value in sharpes.values()) / len(sharpes)
    return {**sharpes, "positiveFraction": float(positive_fraction)}


def _finite_array(values: Iterable[float]) -> NDArray[np.float64]:
    arr = np.asarray(list(values), dtype=np.float64)
    return arr[np.isfinite(arr)]
