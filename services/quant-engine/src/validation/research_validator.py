"""Research-grade validation gates for strategy discovery.

Unlike the baseline backtest validator, these checks require evidence from the
broader research process. Missing evidence is reported as REVIEW rather than
silently treated as a pass.
"""

from __future__ import annotations

import math
from typing import Any

from .advanced import (
    benjamini_hochberg,
    cscv_probability_of_backtest_overfitting,
    deflated_sharpe_ratio,
    equity_returns,
    purged_kfold_splits,
    regime_robustness,
)
from .validator import ValidationCheck, ValidationReport, validate_backtest


DEFAULT_RESEARCH_THRESHOLDS = {
    "min_dsr_probability": 0.95,
    "max_pbo": 0.20,
    "fdr_alpha": 0.05,
    "min_regime_positive_fraction": 0.60,
    "min_regimes": 3,
    "min_equity_returns": 30,
    "min_cv_positive_fraction": 0.60,
    "min_cv_median_sharpe": 0.0,
}


def validate_research(
    result: dict[str, Any],
    evidence: dict[str, Any] | None = None,
    thresholds: dict[str, float] | None = None,
) -> ValidationReport:
    """Combine baseline backtest gates with selection-bias/robustness evidence."""
    evidence = evidence or {}
    cfg = {**DEFAULT_RESEARCH_THRESHOLDS, **(thresholds or {})}
    baseline = validate_backtest(result, thresholds)
    checks = list(baseline.checks)

    equity_curve = result.get("equity_curve", result.get("equityCurve", [])) or []
    returns = equity_returns(equity_curve)
    annualization = float(evidence.get("annualization", 1.0))
    trial_sharpes = evidence.get("trialSharpes", evidence.get("trial_sharpes"))

    if (
        len(returns) >= int(cfg["min_equity_returns"])
        and isinstance(trial_sharpes, list)
        and len(trial_sharpes) >= 2
    ):
        try:
            dsr_probability, benchmark = deflated_sharpe_ratio(
                returns,
                trial_sharpes,
                annualization=annualization,
            )
            if not math.isfinite(dsr_probability):
                raise ValueError("DSR probability is non-finite")
            threshold = float(cfg["min_dsr_probability"])
            checks.append(
                ValidationCheck(
                    name="deflated_sharpe_ratio",
                    verdict="PASS" if dsr_probability >= threshold else "FAIL",
                    value=round(dsr_probability, 6),
                    threshold=threshold,
                    detail=f"Expected maximum Sharpe benchmark: {benchmark:.4f}.",
                )
            )
        except (TypeError, ValueError) as exc:
            checks.append(
                ValidationCheck(
                    name="deflated_sharpe_ratio",
                    verdict="REVIEW",
                    detail=f"Could not evaluate DSR: {exc}",
                )
            )
    else:
        checks.append(
            ValidationCheck(
                name="deflated_sharpe_ratio",
                verdict="REVIEW",
                detail=(
                    "Requires a sufficiently long equity curve and the Sharpe ratios "
                    "of at least two strategy trials."
                ),
            )
        )

    returns_matrix = evidence.get("cscvReturns", evidence.get("cscv_returns"))
    if isinstance(returns_matrix, list) and returns_matrix:
        try:
            pbo = cscv_probability_of_backtest_overfitting(
                returns_matrix,
                n_blocks=int(evidence.get("cscvBlocks", 8)),
                max_combinations=int(evidence.get("maxCscvCombinations", 5000)),
            )
            threshold = float(cfg["max_pbo"])
            checks.append(
                ValidationCheck(
                    name="probability_of_backtest_overfitting",
                    verdict="PASS" if pbo.probability <= threshold else "FAIL",
                    value=round(pbo.probability, 6),
                    threshold=threshold,
                    detail=f"CSCV combinations evaluated: {pbo.combinations_evaluated}.",
                )
            )
        except (TypeError, ValueError) as exc:
            checks.append(
                ValidationCheck(
                    name="probability_of_backtest_overfitting",
                    verdict="REVIEW",
                    detail=f"Could not evaluate PBO: {exc}",
                )
            )
    else:
        checks.append(
            ValidationCheck(
                name="probability_of_backtest_overfitting",
                verdict="REVIEW",
                detail="Requires an observations × strategy-trials OOS return matrix for CSCV.",
            )
        )

    candidate_p_values = evidence.get("candidatePValues", evidence.get("candidate_p_values"))
    selected_index = evidence.get("selectedTrialIndex", evidence.get("selected_trial_index"))
    if isinstance(candidate_p_values, list) and candidate_p_values and selected_index is not None:
        try:
            selected = int(selected_index)
            if selected < 0 or selected >= len(candidate_p_values):
                raise ValueError("selectedTrialIndex is out of range")
            alpha = float(cfg["fdr_alpha"])
            mt = benjamini_hochberg(candidate_p_values, alpha=alpha)
            selected_q = mt.q_values[selected]
            checks.append(
                ValidationCheck(
                    name="multiple_testing_fdr",
                    verdict="PASS" if mt.rejected[selected] else "FAIL",
                    value=round(selected_q, 6),
                    threshold=alpha,
                    detail=f"Benjamini-Hochberg q-value for selected trial {selected}.",
                )
            )
        except (TypeError, ValueError) as exc:
            checks.append(
                ValidationCheck(
                    name="multiple_testing_fdr",
                    verdict="REVIEW",
                    detail=f"Could not evaluate FDR: {exc}",
                )
            )
    else:
        checks.append(
            ValidationCheck(
                name="multiple_testing_fdr",
                verdict="REVIEW",
                detail="Requires candidate p-values and selectedTrialIndex.",
            )
        )

    regime_returns = evidence.get("regimeReturns", evidence.get("regime_returns"))
    if isinstance(regime_returns, dict) and len(regime_returns) >= int(cfg["min_regimes"]):
        try:
            robustness = regime_robustness(regime_returns)
            fraction = float(robustness["positiveFraction"])
            threshold = float(cfg["min_regime_positive_fraction"])
            regime_detail = ", ".join(
                f"{name}={value:.3f}"
                for name, value in robustness.items()
                if name != "positiveFraction"
            )
            checks.append(
                ValidationCheck(
                    name="regime_robustness",
                    verdict="PASS" if fraction >= threshold else "FAIL",
                    value=round(fraction, 6),
                    threshold=threshold,
                    detail=f"Per-regime Sharpe: {regime_detail}.",
                )
            )
        except (TypeError, ValueError) as exc:
            checks.append(
                ValidationCheck(
                    name="regime_robustness",
                    verdict="REVIEW",
                    detail=f"Could not evaluate regime robustness: {exc}",
                )
            )
    else:
        checks.append(
            ValidationCheck(
                name="regime_robustness",
                verdict="REVIEW",
                detail=f"Requires return series for at least {int(cfg['min_regimes'])} regimes.",
            )
        )

    cv = evidence.get("purgedCv", evidence.get("purged_cv"))
    if isinstance(cv, dict) and int(cv.get("nObservations", 0)) >= 2:
        try:
            n_observations = int(cv["nObservations"])
            n_splits = int(cv.get("nSplits", 5))
            purge_bars = int(cv.get("purgeBars", 0))
            embargo_bars = int(cv.get("embargoBars", 0))
            splits = purged_kfold_splits(
                n_samples=n_observations,
                n_splits=n_splits,
                purge=purge_bars,
                embargo=embargo_bars,
            )
            min_train = min(len(split.train_indices) for split in splits)

            folds = cv.get("folds")
            evaluated_folds = int(cv.get("evaluatedFolds", 0))
            if not isinstance(folds, list) or not folds or evaluated_folds != len(folds):
                checks.append(
                    ValidationCheck(
                        name="purged_embargoed_cv",
                        verdict="REVIEW",
                        value=float(evaluated_folds),
                        threshold=float(n_splits),
                        detail=(
                            "Purged split plan exists, but fold-level deterministic "
                            "backtest evidence is incomplete."
                        ),
                    )
                )
            elif len(folds) != n_splits:
                checks.append(
                    ValidationCheck(
                        name="purged_embargoed_cv",
                        verdict="REVIEW",
                        value=float(len(folds)),
                        threshold=float(n_splits),
                        detail="Not every requested purged fold was evaluated.",
                    )
                )
            else:
                fold_sharpes = [float(fold["sharpe"]) for fold in folds]
                fold_returns = [float(fold["netReturn"]) for fold in folds]
                if not all(math.isfinite(value) for value in fold_sharpes + fold_returns):
                    raise ValueError("purged CV fold metrics must be finite")

                positive_fraction = float(cv.get(
                    "positiveSharpeFraction",
                    sum(value > 0 for value in fold_sharpes) / len(fold_sharpes),
                ))
                sorted_sharpes = sorted(fold_sharpes)
                midpoint = len(sorted_sharpes) // 2
                if len(sorted_sharpes) % 2:
                    median_sharpe = sorted_sharpes[midpoint]
                else:
                    median_sharpe = (
                        sorted_sharpes[midpoint - 1] + sorted_sharpes[midpoint]
                    ) / 2.0

                min_fraction = float(cfg["min_cv_positive_fraction"])
                min_median = float(cfg["min_cv_median_sharpe"])
                passed = (
                    min_train > 0
                    and positive_fraction >= min_fraction
                    and median_sharpe >= min_median
                )
                checks.append(
                    ValidationCheck(
                        name="purged_embargoed_cv",
                        verdict="PASS" if passed else "FAIL",
                        value=round(positive_fraction, 6),
                        threshold=min_fraction,
                        detail=(
                            f"{len(folds)} deterministic test folds; "
                            f"median Sharpe={median_sharpe:.4f}; "
                            f"mean net return={sum(fold_returns) / len(fold_returns):.4f}%; "
                            f"minimum train observations={min_train}; "
                            f"purge={purge_bars}; embargo={embargo_bars}."
                        ),
                    )
                )
        except (TypeError, ValueError, KeyError) as exc:
            checks.append(
                ValidationCheck(
                    name="purged_embargoed_cv",
                    verdict="REVIEW",
                    detail=f"Could not evaluate purged fold backtests: {exc}",
                )
            )
    else:
        checks.append(
            ValidationCheck(
                name="purged_embargoed_cv",
                verdict="REVIEW",
                detail=(
                    "Requires purgedCv split metadata plus deterministic fold-level "
                    "backtest metrics."
                ),
            )
        )

    verdicts = {check.verdict for check in checks}
    if "FAIL" in verdicts:
        overall = "FAIL"
    elif "REVIEW" in verdicts:
        overall = "REVIEW"
    else:
        overall = "PASS"

    return ValidationReport(
        strategy_id=baseline.strategy_id,
        checks=checks,
        overall_verdict=overall,
    )
