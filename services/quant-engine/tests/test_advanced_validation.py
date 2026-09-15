import math

import numpy as np
import pytest

from src.validation.advanced import (
    benjamini_hochberg,
    cscv_probability_of_backtest_overfitting,
    deflated_sharpe_ratio,
    equity_returns,
    probabilistic_sharpe_ratio,
    purged_kfold_splits,
    regime_robustness,
)
from src.validation.research_validator import validate_research


def test_equity_returns_and_probabilistic_sharpe_are_finite():
    returns = np.asarray([0.002, 0.001, 0.0025, -0.0005, 0.0015] * 20)
    equity = [100_000.0]
    for value in returns:
        equity.append(equity[-1] * (1.0 + float(value)))

    recovered = equity_returns(equity)
    assert np.allclose(recovered, returns)

    psr = probabilistic_sharpe_ratio(recovered, benchmark_sharpe=0.0)
    assert math.isfinite(psr)
    assert 0.0 <= psr <= 1.0
    assert psr > 0.95


def test_deflated_sharpe_uses_multiple_trial_benchmark():
    returns = [0.002, 0.001, 0.0015, -0.0004, 0.0022] * 30
    probability, benchmark = deflated_sharpe_ratio(
        returns,
        trial_sharpes=[0.1, 0.25, 0.4, 0.55, 0.7],
    )
    assert benchmark > 0
    assert math.isfinite(probability)
    assert 0.0 <= probability <= 1.0


def test_benjamini_hochberg_controls_fdr():
    result = benjamini_hochberg([0.001, 0.02, 0.2, 0.8], alpha=0.05)
    assert result.rejected == [True, True, False, False]
    assert result.q_values[0] == pytest.approx(0.004)
    assert result.q_values[1] == pytest.approx(0.04)


def test_purged_kfold_excludes_purge_and_embargo_ranges():
    splits = purged_kfold_splits(20, n_splits=4, purge=2, embargo=1)
    assert len(splits) == 4

    # Second test fold is [5..9], so [3..10] must be excluded from training.
    second = splits[1]
    assert second.test_indices == [5, 6, 7, 8, 9]
    assert not set(range(3, 11)).intersection(second.train_indices)
    assert {0, 1, 2, 11, 19}.issubset(second.train_indices)


def test_cscv_pbo_detects_selection_instability():
    # Every strategy's block means sum to zero. Selecting the best strategy on
    # one half therefore tends to select a poor strategy on the complement.
    block_scores = np.asarray(
        [
            [4.0, -4.0, 3.0, -3.0],
            [3.0, -3.0, -4.0, 4.0],
            [2.0, -2.0, 1.0, -1.0],
            [1.0, -1.0, -2.0, 2.0],
            [-1.0, 1.0, 2.0, -2.0],
            [-2.0, 2.0, -1.0, 1.0],
            [-3.0, 3.0, 4.0, -4.0],
            [-4.0, 4.0, -3.0, 3.0],
        ]
    )
    rows = []
    for block_id, means in enumerate(block_scores):
        for j in range(10):
            # Shared tiny deterministic variation keeps standard deviations nonzero.
            rows.append(means * 0.001 + ((j - 4.5) * 1e-6))
    matrix = np.asarray(rows)

    result = cscv_probability_of_backtest_overfitting(matrix, n_blocks=8)
    assert result.combinations_evaluated == 70
    assert 0.0 <= result.probability <= 1.0
    assert result.probability > 0.5


def test_regime_robustness_reports_positive_fraction():
    result = regime_robustness(
        {
            "bull": [0.01, 0.012, 0.009, 0.011],
            "bear": [-0.01, -0.008, -0.012, -0.009],
            "sideways": [0.001, 0.002, -0.0005, 0.0015],
        }
    )
    assert result["bull"] > 0
    assert result["bear"] < 0
    assert result["positiveFraction"] == pytest.approx(2 / 3)


def _healthy_result_with_equity():
    returns = [0.002, 0.001, 0.0015, -0.0004, 0.0022] * 25
    equity = [100_000.0]
    for value in returns:
        equity.append(equity[-1] * (1.0 + value))
    return {
        "strategyId": "research-ready",
        "totalTrades": 80,
        "sharpe": 1.4,
        "maxDrawdown": 7.0,
        "profitFactor": 1.6,
        "expectancy": 0.25,
        "equityCurve": equity,
    }


def test_research_validation_marks_missing_evidence_for_review():
    report = validate_research(_healthy_result_with_equity())
    assert report.overall_verdict == "REVIEW"
    advanced = {
        check.name: check.verdict
        for check in report.checks
        if check.name in {
            "deflated_sharpe_ratio",
            "probability_of_backtest_overfitting",
            "multiple_testing_fdr",
            "regime_robustness",
            "purged_embargoed_cv_plan",
        }
    }
    assert set(advanced.values()) == {"REVIEW"}


def test_research_validation_can_pass_with_complete_evidence():
    # Stable multi-strategy matrix; permissive PBO threshold here verifies the
    # evidence plumbing independently of the separate PBO behavior test above.
    rng = np.random.default_rng(7)
    matrix = rng.normal(0.0005, 0.002, size=(80, 4)).tolist()
    evidence = {
        "trialSharpes": [0.1, 0.2, 0.3, 0.4],
        "candidatePValues": [0.001, 0.2, 0.3, 0.4],
        "selectedTrialIndex": 0,
        "cscvReturns": matrix,
        "cscvBlocks": 8,
        "regimeReturns": {
            "bull": [0.01, 0.012, 0.008, 0.009],
            "bear": [0.002, 0.001, 0.003, 0.0015],
            "sideways": [0.001, 0.002, 0.0015, 0.001],
        },
        "purgedCv": {
            "nObservations": 100,
            "nSplits": 5,
            "purgeBars": 2,
            "embargoBars": 2,
        },
    }
    report = validate_research(
        _healthy_result_with_equity(),
        evidence,
        thresholds={
            "min_dsr_probability": 0.0,
            "max_pbo": 1.0,
            "fdr_alpha": 0.05,
            "min_regime_positive_fraction": 0.0,
        },
    )
    assert report.overall_verdict == "PASS"
