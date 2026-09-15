"""
Deterministic backtest engine.

Execution rules are intentionally conservative:
- a signal confirmed on bar i can execute no earlier than bar i+1 open
- long stop-loss / take-profit checks use intrabar low/high
- when both stop and target are touched in the same bar, stop-loss wins
- fees and slippage are included in trade P&L and portfolio equity
- equity is marked to market on every bar

No LLM involvement — pure deterministic computation.
"""

from dataclasses import dataclass, field
import math
import numpy as np
from numpy.typing import NDArray

from .strategy_runner import generate_signals


@dataclass
class Trade:
    entry_index: int
    entry_price: float
    exit_index: int
    exit_price: float
    side: str
    pnl: float
    pnl_pct: float
    fees: float
    slippage: float
    exit_reason: str = "signal"


@dataclass
class BacktestResult:
    strategy_id: str
    net_return: float
    annual_return: float
    sharpe: float
    sortino: float
    max_drawdown: float
    profit_factor: float
    expectancy: float
    total_trades: int
    win_rate: float
    avg_win: float
    avg_loss: float
    fees_paid: float
    slippage_paid: float
    trades: list[Trade] = field(default_factory=list)
    equity_curve: list[float] = field(default_factory=list)


@dataclass
class BacktestConfig:
    initial_capital: float = 100_000.0
    commission_pct: float = 0.04  # 4 bps per side
    slippage_pct: float = 0.02  # 2 bps per side
    position_size_pct: float = 5.0
    candles_per_year: float = 365.25 * 24 * 4  # fallback for 15m data


def _years_between(timestamps: NDArray, n: int, candles_per_year: float) -> float:
    if len(timestamps) >= 2:
        start = float(timestamps[0])
        end = float(timestamps[-1])
        delta = end - start
        if delta > 0:
            # Synthetic/provider timestamps are milliseconds, but tolerate seconds.
            seconds = delta / 1000.0 if max(abs(start), abs(end)) > 1e11 else delta
            years = seconds / (365.25 * 24 * 60 * 60)
            if years > 0:
                return years
    return max(n / max(candles_per_year, 1.0), 1e-9)


def run_backtest(
    strategy: dict,
    open_arr: NDArray,
    high: NDArray,
    low: NDArray,
    close: NDArray,
    volume: NDArray,
    timestamps: NDArray,
    config: BacktestConfig | None = None,
) -> BacktestResult:
    """Run a deterministic, long-only backtest for a Strategy DSL definition."""
    if config is None:
        config = BacktestConfig()

    n = len(close)
    if not (len(open_arr) == len(high) == len(low) == len(volume) == n):
        raise ValueError("OHLCV arrays must have identical lengths")
    if n == 0:
        raise ValueError("OHLCV arrays must not be empty")
    if config.initial_capital <= 0:
        raise ValueError("initial_capital must be positive")

    strategy_id = strategy.get("id", "unknown")
    risk = strategy.get("risk", {})
    stop_loss_pct = risk.get("stopLossPct")
    take_profit_pct = risk.get("takeProfitPct")
    position_pct = float(risk.get("maxPositionPct", config.position_size_pct))
    position_pct = min(max(position_pct, 0.0), 100.0)

    entry_signals, exit_signals = generate_signals(
        strategy, open_arr, high, low, close, volume
    )

    fee_rate = config.commission_pct / 100.0
    slip_rate = config.slippage_pct / 100.0

    cash = float(config.initial_capital)
    units = 0.0
    entry_index = -1
    entry_fill = 0.0
    entry_cost_basis = 0.0
    entry_fee = 0.0
    entry_slippage_cost = 0.0

    trades: list[Trade] = []
    equity_curve: list[float] = []
    total_fees = 0.0
    total_slippage = 0.0

    def enter_position(i: int, raw_price: float) -> None:
        nonlocal cash, units, entry_index, entry_fill, entry_cost_basis
        nonlocal entry_fee, entry_slippage_cost, total_fees, total_slippage

        if cash <= 0 or position_pct <= 0 or raw_price <= 0:
            return

        fill_price = raw_price * (1.0 + slip_rate)
        allocation = cash * position_pct / 100.0
        # Keep fee inside the requested allocation so 100% position size cannot
        # make cash negative solely because of entry commission.
        notional = allocation / (1.0 + fee_rate)
        fee = notional * fee_rate
        qty = notional / fill_price
        if qty <= 0:
            return

        slippage_cost = qty * max(fill_price - raw_price, 0.0)
        cash -= notional + fee
        units = qty
        entry_index = i
        entry_fill = fill_price
        entry_fee = fee
        entry_cost_basis = notional + fee
        entry_slippage_cost = slippage_cost
        total_fees += fee
        total_slippage += slippage_cost

    def exit_position(i: int, raw_price: float, reason: str) -> None:
        nonlocal cash, units, entry_index, entry_fill, entry_cost_basis
        nonlocal entry_fee, entry_slippage_cost, total_fees, total_slippage

        if units <= 0 or raw_price <= 0:
            return

        fill_price = raw_price * (1.0 - slip_rate)
        proceeds = units * fill_price
        fee = proceeds * fee_rate
        slippage_cost = units * max(raw_price - fill_price, 0.0)
        net_proceeds = proceeds - fee
        pnl = net_proceeds - entry_cost_basis
        pnl_pct = (pnl / entry_cost_basis * 100.0) if entry_cost_basis > 0 else 0.0

        cash += net_proceeds
        total_fees += fee
        total_slippage += slippage_cost

        trades.append(
            Trade(
                entry_index=entry_index,
                entry_price=entry_fill,
                exit_index=i,
                exit_price=fill_price,
                side="LONG",
                pnl=float(pnl),
                pnl_pct=float(pnl_pct),
                fees=float(entry_fee + fee),
                slippage=float(entry_slippage_cost + slippage_cost),
                exit_reason=reason,
            )
        )

        units = 0.0
        entry_index = -1
        entry_fill = 0.0
        entry_cost_basis = 0.0
        entry_fee = 0.0
        entry_slippage_cost = 0.0

    for i in range(n):
        exited_at_open = False

        # A signal observed at bar i-1 close may execute at bar i open.
        if i > 0 and units > 0 and bool(exit_signals[i - 1]):
            exit_position(i, float(open_arr[i]), "signal")
            exited_at_open = True

        if i > 0 and units == 0 and not exited_at_open and bool(entry_signals[i - 1]):
            enter_position(i, float(open_arr[i]))

        # Intrabar risk handling for an open long position.
        if units > 0:
            stop_price = None
            target_price = None
            if stop_loss_pct is not None:
                stop_price = entry_fill * (1.0 - float(stop_loss_pct) / 100.0)
            if take_profit_pct is not None:
                target_price = entry_fill * (1.0 + float(take_profit_pct) / 100.0)

            stop_hit = stop_price is not None and float(low[i]) <= stop_price
            target_hit = target_price is not None and float(high[i]) >= target_price

            if stop_hit and target_hit:
                # Without tick data the path is unknown. Choose the adverse fill.
                raw_exit = min(float(open_arr[i]), stop_price) if float(open_arr[i]) <= stop_price else stop_price
                exit_position(i, float(raw_exit), "stop_and_target_same_bar")
            elif stop_hit:
                raw_exit = min(float(open_arr[i]), stop_price) if float(open_arr[i]) <= stop_price else stop_price
                exit_position(i, float(raw_exit), "stop_loss")
            elif target_hit:
                exit_position(i, float(target_price), "take_profit")

        marked_equity = cash + units * float(close[i])
        equity_curve.append(float(marked_equity))

    # Force-close at final close so every result is realized and comparable.
    if units > 0:
        exit_position(n - 1, float(close[-1]), "end_of_data")
        equity_curve[-1] = float(cash)

    final_equity = float(cash)
    total_trades = len(trades)
    net_return = (final_equity / config.initial_capital - 1.0) * 100.0

    years = _years_between(timestamps, n, config.candles_per_year)
    if final_equity <= 0:
        annual_return = -100.0
    else:
        annual_return = (math.pow(final_equity / config.initial_capital, 1.0 / years) - 1.0) * 100.0

    eq = np.asarray(equity_curve, dtype=np.float64)
    peak = np.maximum.accumulate(eq)
    dd = np.where(peak > 0, (peak - eq) / peak * 100.0, 0.0)
    max_drawdown = float(np.nanmax(dd)) if len(dd) else 0.0

    if len(eq) > 1:
        periodic_returns = np.diff(eq) / np.where(eq[:-1] != 0, eq[:-1], np.nan)
        periodic_returns = periodic_returns[np.isfinite(periodic_returns)]
    else:
        periodic_returns = np.asarray([], dtype=np.float64)

    sharpe = 0.0
    sortino = 0.0
    if len(periodic_returns) > 1:
        mean_return = float(np.mean(periodic_returns))
        std_return = float(np.std(periodic_returns, ddof=1))
        if std_return > 1e-12:
            sharpe = mean_return / std_return * math.sqrt(config.candles_per_year)

        downside = np.minimum(periodic_returns, 0.0)
        downside_deviation = float(np.sqrt(np.mean(np.square(downside))))
        if downside_deviation > 1e-12:
            sortino = mean_return / downside_deviation * math.sqrt(config.candles_per_year)

    trade_returns = np.asarray([t.pnl_pct for t in trades], dtype=np.float64)
    trade_pnls = np.asarray([t.pnl for t in trades], dtype=np.float64)
    wins = trade_returns[trade_returns > 0]
    losses = trade_returns[trade_returns <= 0]

    win_rate = (len(wins) / total_trades * 100.0) if total_trades else 0.0
    avg_win = float(np.mean(wins)) if len(wins) else 0.0
    avg_loss = float(np.mean(losses)) if len(losses) else 0.0
    expectancy = float(np.mean(trade_returns)) if total_trades else 0.0

    gross_profit = float(np.sum(trade_pnls[trade_pnls > 0])) if total_trades else 0.0
    gross_loss = float(abs(np.sum(trade_pnls[trade_pnls < 0]))) if total_trades else 0.0
    if gross_loss > 1e-12:
        profit_factor = gross_profit / gross_loss
    elif gross_profit > 0:
        profit_factor = float("inf")
    else:
        profit_factor = 0.0

    return BacktestResult(
        strategy_id=strategy_id,
        net_return=round(float(net_return), 4),
        annual_return=round(float(annual_return), 4),
        sharpe=round(float(sharpe), 4),
        sortino=round(float(sortino), 4),
        max_drawdown=round(float(max_drawdown), 4),
        profit_factor=round(float(profit_factor), 4) if math.isfinite(profit_factor) else profit_factor,
        expectancy=round(float(expectancy), 4),
        total_trades=total_trades,
        win_rate=round(float(win_rate), 2),
        avg_win=round(float(avg_win), 4),
        avg_loss=round(float(avg_loss), 4),
        fees_paid=round(float(total_fees), 4),
        slippage_paid=round(float(total_slippage), 4),
        trades=trades,
        equity_curve=[round(float(v), 6) for v in equity_curve],
    )
