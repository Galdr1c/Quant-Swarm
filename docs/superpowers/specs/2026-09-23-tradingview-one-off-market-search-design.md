# TradingView One-Off Market Search

Date: 2026-09-23
Status: Approved

## Purpose

Let the user search TradingView markets by symbol or exchange, choose one result and timeframe, and run a one-off research pass from the dashboard.

## Decisions

- Use the existing TradingView market-search helper backed by the requested TradingView-API package.
- Require an exchange-qualified result such as NASDAQ:AAPL; display its exchange and description so similarly named markets are distinguishable.
- Research one selected symbol at a time.
- Offer 15m, 1h, 4h, and 1d timeframes, defaulting to 1h.
- Do not save the selected symbol to the configured universe.
- Do not overwrite the existing multi-asset report. Show the one-off report only in the current browser session; reloading restores the existing report.
- Keep this feature research-only. It creates no trading orders.

## User flow

1. The user opens “Piyasa ara” from the dashboard header.
2. The user searches for a symbol, company, or exchange.
3. The dialog lists TradingView results with the full market ID, exchange name, description, and market type.
4. The user selects one result, chooses a timeframe, and starts “Tek Seferlik Araştır”.
5. The UI shows the in-progress state, then displays the returned one-symbol research report in the current dashboard view.
6. Closing the dialog or reloading the page does not change the saved universe. Reloading fetches the previously persisted report.

## Components and data flow

- Add a dashboard market-search dialog and a header action.
- Add a local search route that validates the query and calls the existing TradingView search helper, which uses searchMarketV3.
- Add a local one-off research route that accepts the selected exchange-qualified market ID and an allowed timeframe.
- Run the existing research pipeline for that single subscription through the local quant engine. Write its report to a unique temporary path, return the report to the browser, and remove the temporary file in a finally path.
- Keep the current configured-universe report path separate and unchanged.
- On success, render the returned report in browser memory. On reload, the regular report endpoint supplies the saved multi-asset report again.

## Loading and errors

- The search dialog distinguishes idle, loading, results, no results, and request failure.
- The research action is disabled while a run is active and presents a visible progress state.
- Invalid market IDs or unsupported timeframes are rejected by the local route.
- If TradingView, the research process, or the quant engine fails, show an actionable error and keep the current dashboard report visible.
- Escape user-supplied text before placing it in the DOM.

## Scope exclusions

- No persistent watchlist or universe editing.
- No continuous streaming price display.
- No changes to trading execution or risk behavior.
- No batch selection of multiple markets.

## Acceptance checks

- Searching for AAPL returns exchange-qualified TradingView results, including NASDAQ:AAPL when available.
- A selected market and timeframe produce a one-symbol report and update the current dashboard view.
- The existing multi-asset report remains unchanged after a one-off run.
- Reloading restores the previous report and does not retain the one-off market selection.
- Search or research failures leave the previous report visible and show an error state.
- The workflow creates no orders.

Verification is by manually exercising the browser flow and checking the report endpoint before and after a one-off run. No automated tests are planned for this change.
