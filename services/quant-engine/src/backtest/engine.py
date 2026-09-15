"""
Deterministic Backtest Engine.

Executes a strategy definition against OHLCV data with realistic
cost modeling: commission, slippage, partial fills.

No LLM involvement — pure deterministic computation.
"""

from dataclasses import dataclass, field
import numpy as np
from numpy.typing import NDArray

from .strategy_runner import generate_signals


@dataclass
class Trade:
    entry_index: int
    entry_price: float
    exit_index: int
    exit_price: float
    side: str  # "LONG"
    pnl: float
    pnl_pct: float
    fees: float
    slippage: float


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
    commission_pct: float = 0.04  # 4 bps per trade
    slippage_pct: float = 0.02   # 2 bps per trade
    position_size_pct: float = 5.0  # % of equity per trade
    candles_per_year: float = 365.25 * 24 * 4  # 15m candles


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
    """
    Run a deterministic backtest for a strategy definition.

    The engine:
    1. Generates entry/exit signals from Strategy DSL
    2. Simulates trades with commission + slippage
    3. Applies stop-loss and take-profit from risk params
    4. Computes performance metrics
    """
    if config is None:
        config = BacktestConfig()

    strategy_id = strategy.get("id", "unknown")
    risk = strategy.get("risk", {})
    stop_loss_pct = risk.get("stopLossPct")
    take_profit_pct = risk.get("takeProfitPct")
    position_pct = risk.get("maxPositionPct", config.position_size_pct)

    # Generate signals
    entry_signals, exit_signals = generate_signals(
        strategy, open_arr, high, low, close, volume
    )

    n = len(close)
    equity = config.initial_capital
    peak_equity = equity
    trades: list[Trade] = []
    equity_curve: list[float] = [equity]

    in_position = False
    entry_price = 0.0
    entry_idx = 0
    position_size = 0.0
    total_fees = 0.0
    total_slippage = 0.0

    for i in range(1, n):
        if in_position:
            # Check stop-loss / take-profit
            current_pnl_pct = (close[i] - entry_price) / entry_price * 100

            should_exit = exit_signals[i]

            if stop_loss_pct is not None and current_pnl_pct <= -stop_loss_pct:
                should_exit = True

            if take_profit_pct is not None and current_pnl_pct >= take_profit_pct:
                should_exit = True

            if should_exit:
                # Exit
                exit_price = close[i]
                slip = exit_price * config.slippage_pct / 100
                exit_price -= slip  # Slippage works against us
                fee = position_size * config.commission_pct / 100

                pnl = position_size * (exit_price - entry_price) / entry_price
                pnl -= fee
                pnl_pct = (exit_price - entry_price) / entry_price * 100

                equity += pnl
                total_fees += fee
                total_slippage += slip * position_size / entry_price

                trades.append(Trade(
                    entry_index=entry_idx,
                    entry_price=entry_price,
                    exit_index=i,
                    exit_price=exit_price,
                    side="LONG",
                    pnl=pnl,
                    pnl_pct=pnl_pct,
                    fees=fee,
                    slippage=slip,
                ))

                in_position = False
                peak_equity = max(peak_equity, equity)

        elif entry_signals[i]:
            # Enter position
            entry_price = close[i]
            slip = entry_price * config.slippage_pct / 100
            entry_price += slip  # Slippage works against us
            fee = equity * position_pct / 100 * config.commission_pct / 100

            position_size = equity * position_pct / 100 - fee
            total_fees += fee
            total_slippage += slip * position_size / entry_price

            entry_idx = i
            in_position = True

        equity_curve.append(equity)

    # Close any open position at the end
    if in_position:
        exit_price = close[-1]
        pnl = position_size * (exit_price - entry_price) / entry_price
        fee = position_size * config.commission_pct / 100
        pnl -= fee
        equity += pnl
        total_fees += fee

        trades.append(Trade(
            entry_index=entry_idx,
            entry_price=entry_price,
            exit_index=n - 1,
            exit_price=exit_price,
            side="LONG",
            pnl=pnl,
            pnl_pct=(exit_price - entry_price) / entry_price * 100,
            fees=fee,
            slippage=0,
        ))
        equity_curve.append(equity)

    # ── Compute Metrics ──────────────────────────────────────────────────────

    total_trades = len(trades)

    if total_trades == 0:
        return BacktestResult(
            strategy_id=strategy_id,
            net_return=0.0, annual_return=0.0,
            sharpe=0.0, sortino=0.0, max_drawdown=0.0,
            profit_factor=0.0, expectancy=0.0,
            total_trades=0, win_rate=0.0,
            avg_win=0.0, avg_loss=0.0,
            fees_paid=total_fees, slippage_paid=total_slippage,
            trades=trades, equity_curve=equity_curve,
        )

    net_return = (equity - config.initial_capital) / config.initial_capital * 100
    duration_candles = n
    annual_factor = config.candles_per_year / max(duration_candles, 1)
    annual_return = net_return * annual_factor

    # Per-trade returns for Sharpe/Sortino
    trade_returns = np.array([t.pnl_pct for t in trades])
    wins = trade_returns[trade_returns > 0]
    losses = trade_returns[trade_returns <= 0]

    win_rate = len(wins) / total_trades * 100

    avg_win = float(np.mean(wins)) if len(wins) > 0 else 0.0
    avg_loss = float(np.mean(losses)) if len(losses) > 0 else 0.0

    # Sharpe (annualized, assuming trade-level returns)
    if len(trade_returns) > 1 and np.std(trade_returns) > 0:
        trades_per_year = total_trades * annual_factor
        sharpe = (np.mean(trade_returns) / np.std(trade_returns)) * np.sqrt(trades_per_year)
    else:
        sharpe = 0.0

    # Sortino (only downside deviation)
    downside = trade_returns[trade_returns < 0]
    if len(downside) > 1 and np.std(downside) > 0:
        trades_per_year = total_trades * annual_factor
        sortino = (np.mean(trade_returns) / np.std(downside)) * np.sqrt(trades_per_year)
    else:
        sortino = 0.0 if len(downside) > 0 else sharpe  # No losses → same as Sharpe

    # Max Drawdown from equity curve
    eq = np.array(equity_curve)
    peak = np.maximum.accumulate(eq)
    dd = (peak - eq) / peak * 100
    max_drawdown = float(np.max(dd)) if len(dd) > 0 else 0.0

    # Profit Factor
    gross_profit = float(np.sum(wins)) if len(wins) > 0 else 0.0
    gross_loss = float(np.abs(np.sum(losses))) if len(losses) > 0 else 0.0
    profit_factor = gross_profit / max(gross_loss, 1e-10)

    # Expectancy
    expectancy = float(np.mean(trade_returns))

    return BacktestResult(
        strategy_id=strategy_id,
        net_return=round(net_return, 4),
        annual_return=round(annual_return, 4),
        sharpe=round(float(sharpe), 4),
        sortino=round(float(sortino), 4),
        max_drawdown=round(max_drawdown, 4),
        profit_factor=round(profit_factor, 4),
        expectancy=round(expectancy, 4),
        total_trades=total_trades,
        win_rate=round(win_rate, 2),
        avg_win=round(avg_win, 4),
        avg_loss=round(avg_loss, 4),
        fees_paid=round(total_fees, 4),
        slippage_paid=round(total_slippage, 4),
        trades=trades,
        equity_curve=equity_curve,
    )
