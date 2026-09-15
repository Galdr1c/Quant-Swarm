"""
Deterministic baseline validation gates.

This module is intentionally conservative and does not claim to be a complete
quant-grade research validator yet. Milestone 2 should add walk-forward tests,
purged/embargoed cross validation, Deflated Sharpe Ratio, multiple-testing
corrections and regime robustness checks.
"""

from dataclasses import dataclass, asdict
import math
from typing import Any


@dataclass
class ValidationCheck:
    name: str
    verdict: str  # PASS | FAIL | REVIEW
    value: float | int | None = None
    threshold: float | int | None = None
    detail: str | None = None


@dataclass
class ValidationReport:
    strategy_id: str
    checks: list[ValidationCheck]
    overall_verdict: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "strategyId": self.strategy_id,
            "checks": [
                {
                    "name": c.name,
                    "verdict": c.verdict,
                    "value": c.value,
                    "threshold": c.threshold,
                    "detail": c.detail,
                }
                for c in self.checks
            ],
            "overallVerdict": self.overall_verdict,
        }


DEFAULT_THRESHOLDS = {
    "min_trades": 30,
    "min_sharpe": 0.5,
    "max_drawdown": 15.0,
    "min_profit_factor": 1.15,
    "min_expectancy": 0.0,
}


def _metric(result: dict[str, Any], snake: str, camel: str) -> float:
    value = result.get(snake, result.get(camel, 0.0))
    if value is None:
        return float("nan")
    return float(value)


def validate_backtest(
    result: dict[str, Any],
    thresholds: dict[str, float] | None = None,
) -> ValidationReport:
    """Validate a backtest result without relying on win-rate thresholds."""
    cfg = {**DEFAULT_THRESHOLDS, **(thresholds or {})}
    strategy_id = str(result.get("strategy_id", result.get("strategyId", "unknown")))

    total_trades = int(_metric(result, "total_trades", "totalTrades"))
    sharpe = _metric(result, "sharpe", "sharpe")
    max_drawdown = _metric(result, "max_drawdown", "maxDrawdown")
    profit_factor = _metric(result, "profit_factor", "profitFactor")
    expectancy = _metric(result, "expectancy", "expectancy")

    checks: list[ValidationCheck] = []

    finite_metrics = [sharpe, max_drawdown, profit_factor, expectancy]
    if not all(math.isfinite(v) for v in finite_metrics):
        checks.append(
            ValidationCheck(
                name="finite_metrics",
                verdict="FAIL",
                detail="Backtest contains non-finite metrics.",
            )
        )
    else:
        checks.append(ValidationCheck(name="finite_metrics", verdict="PASS"))

    checks.append(
        ValidationCheck(
            name="minimum_trades",
            verdict="PASS" if total_trades >= int(cfg["min_trades"]) else "REVIEW",
            value=total_trades,
            threshold=int(cfg["min_trades"]),
            detail="Small samples require more out-of-sample evidence." if total_trades < int(cfg["min_trades"]) else None,
        )
    )

    checks.append(
        ValidationCheck(
            name="sharpe",
            verdict="PASS" if sharpe >= cfg["min_sharpe"] else "FAIL",
            value=round(sharpe, 4),
            threshold=cfg["min_sharpe"],
        )
    )

    checks.append(
        ValidationCheck(
            name="max_drawdown",
            verdict="PASS" if max_drawdown <= cfg["max_drawdown"] else "FAIL",
            value=round(max_drawdown, 4),
            threshold=cfg["max_drawdown"],
        )
    )

    checks.append(
        ValidationCheck(
            name="profit_factor",
            verdict="PASS" if profit_factor >= cfg["min_profit_factor"] else "FAIL",
            value=round(profit_factor, 4),
            threshold=cfg["min_profit_factor"],
        )
    )

    checks.append(
        ValidationCheck(
            name="expectancy",
            verdict="PASS" if expectancy > cfg["min_expectancy"] else "FAIL",
            value=round(expectancy, 4),
            threshold=cfg["min_expectancy"],
        )
    )

    verdicts = {c.verdict for c in checks}
    if "FAIL" in verdicts:
        overall = "FAIL"
    elif "REVIEW" in verdicts:
        overall = "REVIEW"
    else:
        overall = "PASS"

    return ValidationReport(
        strategy_id=strategy_id,
        checks=checks,
        overall_verdict=overall,
    )
