const state = {
  report: null,
  filter: "ALL",
  selectedIndex: 0,
  chartSymbol: null,
  chartTimeframe: "1h",
  priceCandles: [],
  tradeMarkers: [],
  paperTradingReady: false,
  paperKillSwitchActive: false,
};

let marketSearchTimer = null;
let marketSearchVersion = 0;
let marketChartVersion = 0;
let selectedMarket = null;

const $ = (id) => document.getElementById(id);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const finePointer = matchMedia("(pointer: fine)").matches;

document.addEventListener("DOMContentLoaded", () => {
  $("refresh-button")?.addEventListener("click", () => loadReport(true));
  $("run-button")?.addEventListener("click", copyRunCommand);
  $("market-search-open")?.addEventListener("click", openMarketSearch);
  $("market-search-close")?.addEventListener("click", () => $("market-search-dialog")?.close());
  $("market-search-dialog")?.addEventListener("click", (event) => {
    if (event.target === $("market-search-dialog")) $("market-search-dialog").close();
  });
  $("market-search-query")?.addEventListener("input", scheduleMarketSearch);
  $("market-search-type")?.addEventListener("change", scheduleMarketSearch);
  $("market-timeframe")?.addEventListener("change", () => {
    updateResearchAction();
    if (!selectedMarket) return;
    state.chartSymbol = selectedMarket.id;
    state.chartTimeframe = $("market-timeframe").value;
    syncChartControls();
    loadMarketChart();
  });
  $("market-research-button")?.addEventListener("click", runOneOffResearch);
  $("chart-timeframes")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-chart-timeframe]");
    if (!button || !state.chartSymbol) return;
    state.chartTimeframe = button.dataset.chartTimeframe;
    syncChartControls();
    loadMarketChart();
  });
  $("chart-research-button")?.addEventListener("click", runChartResearch);
  $("paper-buy-button")?.addEventListener("click", () => placePaperOrder("BUY"));
  $("paper-sell-button")?.addEventListener("click", () => placePaperOrder("SELL"));
  $("paper-order-quantity")?.addEventListener("input", syncChartControls);

  $("filters")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]");
    if (!button) return;

    state.filter = button.dataset.filter;
    document.querySelectorAll(".filter").forEach((node) => {
      node.classList.toggle("active", node === button);
    });

    transition(() => renderFleet());
  });

  document.querySelectorAll("[data-jump]").forEach((button) => {
    button.addEventListener("click", () => {
      const selector = button.getAttribute("data-jump");
      const target = selector ? document.querySelector(selector) : null;
      if (!target) return;
      target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
      document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
    });
  });

  installTilt();
  installScrollSpy();
  loadReport(false);
});

async function loadReport(showRefreshToast) {
  try {
    $("refresh-button")?.setAttribute("aria-busy", "true");
    const response = await fetch("/api/report", { cache: "no-store" });
    if (!response.ok) throw new Error("Report request failed: " + response.status);

    const report = await response.json();
    transition(() => {
      state.report = report;
      state.selectedIndex = 0;
      render();
    });

    if (showRefreshToast) {
      toast(report.demo ? "Demo galaxy refreshed" : "Research universe refreshed");
    } else if (report.demo) {
      toast("Demo galaxy loaded — run research:universe for real evidence");
    }
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error));
  } finally {
    $("refresh-button")?.removeAttribute("aria-busy");
  }
}

function render() {
  const report = state.report;
  if (!report) return;

  const summary = report.summary || {};
  $("generated-at").textContent = formatDate(report.generatedAt);
  $("demo-badge").hidden = !report.demo;

  $("kpi-assets").textContent = formatInteger(summary.completed || 0);
  $("kpi-assets-note").textContent =
    (summary.assets || 0) + " configured · " + (summary.noSignal || 0) + " no signal";

  $("kpi-positive").textContent = formatPercent(summary.positiveHoldoutRate || 0, 1);
  $("kpi-pass").textContent = String(summary.pass || 0);
  $("kpi-pass-note").textContent =
    (summary.review || 0) + " review · " + (summary.fail || 0) + " fail";

  $("kpi-return").textContent = formatSignedPercent(summary.averageHoldoutReturn || 0, 1);
  $("median-sharpe").textContent = formatNumber(summary.medianHoldoutSharpe || 0, 2);

  const completed = (report.results || []).filter((row) => row.status === "COMPLETED");
  const selected = completed[0];

  if (selected) {
    const index = (report.results || []).indexOf(selected);
    state.selectedIndex = Math.max(index, 0);
  } else {
    state.selectedIndex = 0;
  }

  renderHero(selected);
  renderValidation(selected);
  renderFleet();

  if (selected) {
    renderDetail(selected, state.selectedIndex);
    selectChartMarket(selected);
  } else {
    clearMarketChart();
  }
}

function renderHero(row) {
  const card = document.querySelector(".market-planet-card");

  if (!row) {
    $("hero-symbol").textContent = "No surviving explorer";
    ["hero-return", "hero-sharpe", "hero-drawdown", "hero-winrate"].forEach((id) => {
      $(id).textContent = "—";
    });
    $("planet-label").textContent = "QS";
    setVerdict($("hero-verdict"), null);
    card?.removeAttribute("data-verdict");
    return;
  }

  const label = shortSymbol(row.symbol);
  $("hero-symbol").textContent = label + " · " + row.timeframe;
  $("planet-label").textContent = planetMonogram(label);
  $("hero-return").textContent = formatSignedPercent(row.finalHoldout?.netReturn, 2);
  $("hero-sharpe").textContent = formatNumber(row.finalHoldout?.sharpe, 2);
  $("hero-drawdown").textContent = formatSignedPercent(row.finalHoldout?.maxDrawdown, 2);
  $("hero-winrate").textContent = formatPercent(row.finalHoldout?.winRate, 1);
  setVerdict($("hero-verdict"), row.verdict);

  if (card) card.dataset.verdict = row.verdict || "NEUTRAL";
}

function renderValidation(row) {
  const root = $("validation-list");
  if (!root) return;
  root.innerHTML = "";

  const allChecks = Array.isArray(row?.checks) ? row.checks : [];
  const cvCheck = allChecks.find((check) => check.name === "purged_embargoed_cv");
  const checks = [
    ...(cvCheck ? [cvCheck] : []),
    ...allChecks.filter((check) => check !== cvCheck),
  ].slice(0, 7);
  if (!checks.length) {
    root.innerHTML =
      '<div class="validation-row"><div><strong>No validation evidence</strong><small>Launch universe research first.</small></div><em class="verdict neutral">—</em></div>';
    return;
  }

  checks.forEach((check, index) => {
    const element = document.createElement("div");
    element.className = "validation-row";
    element.style.setProperty("--row", String(index));
    element.innerHTML =
      '<div><strong>' +
      escapeHtml(prettyCheck(check.name)) +
      "</strong><small>" +
      escapeHtml(check.detail || metricDetail(check)) +
      '</small></div><em class="verdict ' +
      verdictClass(check.verdict) +
      '">' +
      escapeHtml(check.verdict) +
      "</em>";
    root.appendChild(element);
  });
}

function renderFleet() {
  const root = $("opportunity-rows");
  if (!root || !state.report) return;
  root.innerHTML = "";

  const all = state.report.results || [];
  const rows = all.filter((row) => state.filter === "ALL" || row.verdict === state.filter);

  rows.forEach((row) => {
    const rank = all.indexOf(row) + 1;
    const done = row.status === "COMPLETED";
    const node = document.createElement("article");
    node.className = "fleet-row";
    node.tabIndex = 0;
    node.setAttribute(
      "aria-label",
      shortSymbol(row.symbol) + " " + row.timeframe + " " + (row.verdict || statusLabel(row.status))
    );

    if (rank - 1 === state.selectedIndex) node.classList.add("selected");

    node.innerHTML =
      '<div class="fleet-rank">' +
      String(rank).padStart(2, "0") +
      '</div><div class="fleet-market"><strong>' +
      escapeHtml(shortSymbol(row.symbol)) +
      "</strong><small>" +
      escapeHtml(exchangeName(row.symbol)) +
      " · " +
      escapeHtml(row.timeframe) +
      '</small></div><div class="fleet-strategy"><strong>' +
      escapeHtml(row.selectedStrategy?.name || statusLabel(row.status)) +
      "</strong><small>" +
      escapeHtml(row.candidate?.type || row.error || "—") +
      '</small></div><div class="fleet-value fleet-holdout ' +
      numberClass(row.finalHoldout?.netReturn) +
      '">' +
      (done ? formatSignedPercent(row.finalHoldout?.netReturn, 2) : "—") +
      '</div><div class="fleet-value fleet-sharpe">' +
      (done ? formatNumber(row.finalHoldout?.sharpe, 2) : "—") +
      '</div><div class="fleet-value fleet-drawdown ' +
      numberClass(row.finalHoldout?.maxDrawdown) +
      '">' +
      (done ? formatSignedPercent(row.finalHoldout?.maxDrawdown, 2) : "—") +
      '</div><div class="fleet-value fleet-win">' +
      (done ? formatPercent(row.finalHoldout?.winRate, 1) : "—") +
      '</div><div class="fleet-verdict"><em class="verdict ' +
      verdictClass(row.verdict) +
      '">' +
      escapeHtml(row.verdict || statusLabel(row.status)) +
      "</em></div>";

    const choose = () => selectRow(row, rank - 1, node);
    node.addEventListener("click", choose);
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        choose();
      }
    });

    root.appendChild(node);
  });

  if (!rows.length) {
    root.innerHTML =
      '<div class="empty-row">No tiny explorers live in this filter yet.</div>';
  }
}

function selectRow(row, index, node) {
  transition(() => {
    state.selectedIndex = index;
    document.querySelectorAll(".fleet-row").forEach((item) => item.classList.remove("selected"));
    node.classList.add("selected");
    renderDetail(row, index);

    if (row.status === "COMPLETED") {
      renderHero(row);
      renderValidation(row);
    }
  });

  if (row.status === "COMPLETED") selectChartMarket(row);
}

function renderDetail(row, index) {
  $("detail-title").textContent = shortSymbol(row.symbol) + " · " + row.timeframe;

  const final = row.finalHoldout;
  const validation = row.validation;
  const content = $("detail-content");
  if (!content) return;

  content.innerHTML =
    '<div class="detail-grid">' +
    detail("Fleet rank", "#" + (index + 1)) +
    detail("Candidate", row.candidate?.type || "—") +
    detail("Signal score", formatNumber(row.candidate?.score, 2)) +
    detail("Validation return", formatSignedPercent(validation?.netReturn, 2)) +
    detail("CV median Sharpe", formatNumber(row.purgedCv?.medianSharpe, 2)) +
    detail(
      "Positive CV folds",
      Number.isFinite(Number(row.purgedCv?.positiveSharpeFraction))
        ? formatPercent(Number(row.purgedCv.positiveSharpeFraction) * 100, 1)
        : "—"
    ) +
    detail("Holdout PF", formatNumber(final?.profitFactor, 2)) +
    detail("Trades", formatInteger(final?.totalTrades || 0)) +
    '</div><div class="detail-note"><strong>' +
    escapeHtml(row.selectedStrategy?.name || statusLabel(row.status)) +
    "</strong><br>" +
    (row.runId ? "Run: " + escapeHtml(row.runId) + "<br>" : "") +
    "The cartoon fleet is decorative. Ranking uses validation/OOS metrics only; final holdout is displayed as post-selection evidence and never decides fleet order.</div>";
}

function detail(label, value) {
  return (
    '<div class="detail-stat"><span>' +
    escapeHtml(label) +
    "</span><strong>" +
    escapeHtml(value) +
    "</strong></div>"
  );
}

function selectChartMarket(row) {
  if (!row?.symbol) return clearMarketChart();
  state.chartSymbol = row.symbol;
  state.chartTimeframe = supportedChartTimeframe(row.timeframe)
    ? row.timeframe
    : state.chartTimeframe;
  syncChartControls();
  loadMarketChart();
}

function supportedChartTimeframe(value) {
  return ["5m", "15m", "1h", "4h", "1d"].includes(value);
}

function syncChartControls() {
  const symbol = state.chartSymbol;
  $("market-chart-symbol").textContent = symbol
    ? shortSymbol(symbol) + " · " + state.chartTimeframe
    : "Select a market";

  document.querySelectorAll("[data-chart-timeframe]").forEach((button) => {
    const active = button.dataset.chartTimeframe === state.chartTimeframe;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  const latestPrice = Number(state.priceCandles.at(-1)?.close);
  const hasTradablePrice = Number.isFinite(latestPrice) && latestPrice > 0;
  const quantity = Number($("paper-order-quantity")?.value);
  const validQuantity = Number.isFinite(quantity) && quantity > 0;
  const paperBusy =
    $("paper-buy-button")?.getAttribute("aria-busy") === "true" ||
    $("paper-sell-button")?.getAttribute("aria-busy") === "true";
  const paperAllowed =
    state.paperTradingReady && !state.paperKillSwitchActive;

  const orderMarket = $("paper-order-market");
  if (orderMarket) {
    orderMarket.textContent =
      symbol && hasTradablePrice
        ? shortSymbol(symbol) + " @ " + formatNumber(latestPrice, 4)
        : "Select a market";
  }
  ["paper-buy-button", "paper-sell-button"].forEach((id) => {
    const button = $(id);
    if (button) {
      button.disabled =
        !symbol || !hasTradablePrice || !validQuantity || paperBusy || !paperAllowed;
    }
  });

  const analyze = $("chart-research-button");
  if (analyze) {
    analyze.disabled = !symbol || analyze.getAttribute("aria-busy") === "true";
    if (analyze.getAttribute("aria-busy") !== "true") {
      analyze.textContent = "Analyze " + state.chartTimeframe;
    }
  }
}

function clearMarketChart() {
  marketChartVersion += 1;
  state.chartSymbol = null;
  state.priceCandles = [];
  state.tradeMarkers = [];
  $("price-line-path")?.setAttribute("d", "");
  $("price-area-path")?.setAttribute("d", "");
  $("trade-marker-layer")?.replaceChildren();
  $("market-chart-status").textContent = "Select an opportunity to load TradingView prices.";
  syncChartControls();
}

async function loadMarketChart() {
  const symbol = state.chartSymbol;
  const timeframe = state.chartTimeframe;
  if (!symbol || !supportedChartTimeframe(timeframe)) return;

  const version = ++marketChartVersion;
  $("market-chart-status").textContent =
    shortSymbol(symbol) + " " + timeframe + " prices loading…";
  syncChartControls();

  const historyQuery = new URLSearchParams({
    symbol,
    timeframe,
    limit: "300",
  });
  const tradesQuery = new URLSearchParams({ symbol });

  try {
    const [historyResponse, tradesResponse] = await Promise.all([
      fetch("/api/market/history?" + historyQuery.toString(), { cache: "no-store" }),
      fetch("/api/trades?" + tradesQuery.toString(), { cache: "no-store" }),
    ]);
    const history = await historyResponse.json().catch(() => ({}));
    const trades = await tradesResponse.json().catch(() => ({}));
    if (version !== marketChartVersion) return;
    if (!historyResponse.ok) throw new Error(history.error || "Price history could not be loaded.");
    if (!tradesResponse.ok) throw new Error(trades.error || "Trade markers could not be loaded.");

    state.priceCandles = Array.isArray(history.candles) ? history.candles : [];
    state.tradeMarkers = Array.isArray(trades.trades) ? trades.trades : [];
    drawPriceChart(state.priceCandles, state.tradeMarkers);
    await loadPaperPortfolio(symbol);
    if (version !== marketChartVersion) return;

    const paper = state.tradeMarkers.filter((trade) => trade.mode === "paper").length;
    const live = state.tradeMarkers.filter((trade) => trade.mode === "live").length;
    $("market-chart-status").textContent =
      timeframe + " · " + state.priceCandles.length + " closed bars · " +
      paper + " paper trades · " + live + " live trades";
  } catch (error) {
    if (version !== marketChartVersion) return;
    state.priceCandles = [];
    state.tradeMarkers = [];
    drawPriceChart([], []);
    $("market-chart-status").textContent =
      error instanceof Error ? error.message : "Market chart failed.";
  }
}

async function placePaperOrder(side) {
  const symbol = state.chartSymbol;
  const price = Number(state.priceCandles.at(-1)?.close);
  const quantity = Number($("paper-order-quantity")?.value);
  if (!symbol || !Number.isFinite(price) || price <= 0) {
    return toast("Load a market price before placing a paper order");
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return toast("Paper quantity must be positive");
  }

  const activeButton = side === "BUY" ? $("paper-buy-button") : $("paper-sell-button");
  ["paper-buy-button", "paper-sell-button"].forEach((id) => {
    $(id)?.setAttribute("aria-busy", "true");
  });
  if (activeButton) activeButton.textContent = side === "BUY" ? "Buying…" : "Selling…";
  syncChartControls();

  try {
    const response = await fetch("/api/paper/order", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        symbol,
        side,
        quantity,
        timeframe: state.chartTimeframe,
        strategyId: "dashboard-paper",
        reduceOnly: side === "SELL",
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (result?.killSwitchActive === true) {
        state.paperKillSwitchActive = true;
        state.paperTradingReady = false;
        const riskStatus = $("paper-risk-status");
        if (riskStatus) {
          riskStatus.textContent = "KILL SWITCH ACTIVE · paper orders locked";
        }
      } else if (response.status === 502) {
        state.paperTradingReady = false;
        const riskStatus = $("paper-risk-status");
        if (riskStatus) {
          riskStatus.textContent = "Risk marks unavailable · paper orders locked";
        }
      }
      syncChartControls();
      const reason = result?.risk?.reason ? " · " + result.risk.reason : "";
      throw new Error((result.error || "Paper order failed.") + reason);
    }

    toast(
      "PAPER " + side + " " + formatNumber(quantity, 6) + " " +
      shortSymbol(symbol) + " @ " + formatNumber(result.fill?.price ?? price, 4)
    );
    await loadMarketChart();
  } catch (error) {
    toast(error instanceof Error ? error.message : "Paper order failed.");
  } finally {
    ["paper-buy-button", "paper-sell-button"].forEach((id) => {
      const button = $(id);
      button?.removeAttribute("aria-busy");
      if (button) button.textContent = id === "paper-buy-button" ? "Paper Buy" : "Paper Sell";
    });
    syncChartControls();
  }
}

async function loadPaperPortfolio(symbol) {
  const query = new URLSearchParams({ symbol });
  try {
    const response = await fetch("/api/portfolio?" + query.toString(), { cache: "no-store" });
    const portfolio = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(portfolio.error || "Paper portfolio failed.");

    state.paperKillSwitchActive = portfolio.killSwitchActive === true;
    state.paperTradingReady = !state.paperKillSwitchActive;
    const riskStatus = $("paper-risk-status");
    if (riskStatus) {
      riskStatus.textContent = state.paperKillSwitchActive
        ? "KILL SWITCH ACTIVE · paper orders locked"
        : "Risk gate ready · server-marked · no live execution";
    }

    $("paper-equity").textContent = formatNumber(portfolio.equity, 2);
    $("paper-cash").textContent = formatNumber(portfolio.cash, 2);
    $("paper-realized").textContent = signedNumber(portfolio.realizedPnl, 2);
    $("paper-unrealized").textContent = signedNumber(portfolio.unrealizedPnl, 2);
    $("paper-daily").textContent =
      signedNumber(portfolio.dailyPnl, 2) + " (" +
      signedNumber(portfolio.dailyPnlPct, 2) + "%)";
    $("paper-positions").textContent = String(
      Array.isArray(portfolio.positions) ? portfolio.positions.length : 0
    );
  } catch {
    state.paperTradingReady = false;
    const riskStatus = $("paper-risk-status");
    if (riskStatus) riskStatus.textContent = "Risk gate unavailable · paper orders locked";
    ["paper-equity", "paper-cash", "paper-realized", "paper-unrealized", "paper-daily", "paper-positions"]
      .forEach((id) => {
        const node = $(id);
        if (node) node.textContent = "—";
      });
  }
  syncChartControls();
}

function signedNumber(value, decimals = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  const prefix = number > 0 ? "+" : "";
  return prefix + formatNumber(number, decimals);
}

function drawPriceChart(candles, trades) {
  const line = $("price-line-path");
  const area = $("price-area-path");
  const layer = $("trade-marker-layer");
  if (!line || !area || !layer) return;

  layer.replaceChildren();
  const rows = (Array.isArray(candles) ? candles : [])
    .map((row) => ({
      timestamp: Number(row.timestamp),
      close: Number(row.close),
    }))
    .filter((row) => Number.isFinite(row.timestamp) && Number.isFinite(row.close))
    .sort((a, b) => a.timestamp - b.timestamp);

  if (rows.length < 2) {
    line.setAttribute("d", "");
    area.setAttribute("d", "");
    return;
  }

  const width = 760;
  const top = 22;
  const bottom = 228;
  const firstTs = rows[0].timestamp;
  const lastTs = rows.at(-1).timestamp;
  const visibleTrades = (Array.isArray(trades) ? trades : [])
    .map((trade) => ({ ...trade, timestamp: Number(trade.timestamp), price: Number(trade.price) }))
    .filter((trade) =>
      Number.isFinite(trade.timestamp) &&
      Number.isFinite(trade.price) &&
      trade.timestamp >= firstTs
    );

  const priceValues = rows.map((row) => row.close).concat(visibleTrades.map((trade) => trade.price));
  const min = Math.min(...priceValues);
  const max = Math.max(...priceValues);
  const range = Math.max(max - min, Math.abs(max) * 0.002, 1e-9);
  const timeRange = Math.max(lastTs - firstTs, 1);

  const xFor = (timestamp) => ((timestamp - firstTs) / timeRange) * width;
  const yFor = (price) => bottom - ((price - min) / range) * (bottom - top);
  const points = rows.map((row) => [xFor(row.timestamp), yFor(row.close)]);
  const path = points
    .map(([x, y], index) => (index === 0 ? "M " : "L ") + x.toFixed(2) + " " + y.toFixed(2))
    .join(" ");

  line.setAttribute("d", path);
  area.setAttribute("d", path + " L " + width + " " + bottom + " L 0 " + bottom + " Z");

  visibleTrades.forEach((trade) => {
    // A fill can occur after the timestamp of the latest *closed* candle.
    // Keep its real ledger timestamp, but project it onto the chart's right
    // edge until the next closed candle arrives so the marker is visible now.
    const plottedTimestamp = Math.min(trade.timestamp, lastTs);
    const x = xFor(plottedTimestamp);
    const y = yFor(trade.price);
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.setAttribute(
      "class",
      "trade-marker " + trade.mode + " " + String(trade.side).toLowerCase()
    );
    group.setAttribute("transform", "translate(" + x.toFixed(2) + " " + y.toFixed(2) + ")");

    const marker = document.createElementNS("http://www.w3.org/2000/svg", "path");
    marker.setAttribute(
      "d",
      trade.side === "BUY"
        ? "M 0 -9 L -7 6 L 7 6 Z"
        : "M 0 9 L -7 -6 L 7 -6 Z"
    );

    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent =
      trade.mode.toUpperCase() + " " + trade.side + " · " +
      formatNumber(trade.price, 4) +
      (Number.isFinite(Number(trade.quantity)) ? " · qty " + formatNumber(trade.quantity, 4) : "") +
      (Number.isFinite(Number(trade.fee)) ? " · fee " + formatNumber(trade.fee, 4) : "") +
      (trade.source ? " · " + trade.source : "") +
      " · " + formatDate(trade.timestamp);
    group.append(marker, title);
    layer.append(group);
  });

  if (!reduceMotion && typeof line.animate === "function") {
    const length = line.getTotalLength?.() || 0;
    if (length > 0) {
      line.style.strokeDasharray = String(length);
      line.style.strokeDashoffset = String(length);
      line.animate(
        [{ strokeDashoffset: length }, { strokeDashoffset: 0 }],
        { duration: 700, easing: "cubic-bezier(.16,.84,.24,1)", fill: "forwards" }
      );
    }
  }
}

async function runChartResearch() {
  const symbol = state.chartSymbol;
  const timeframe = state.chartTimeframe;
  const button = $("chart-research-button");
  if (!symbol || !button) return;

  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = "Analyzing…";
  $("market-chart-status").textContent =
    shortSymbol(symbol) + " " + timeframe + " research running…";

  try {
    const response = await fetch("/api/research/once", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol, timeframe }),
    });
    const report = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(report.error || "Research failed.");
    if (!Array.isArray(report.results)) throw new Error("Research report has an invalid shape.");

    state.filter = "ALL";
    state.selectedIndex = 0;
    document.querySelectorAll(".filter").forEach((node) => {
      node.classList.toggle("active", node.dataset.filter === "ALL");
    });
    transition(() => {
      state.report = report;
      render();
    });

    state.chartSymbol = symbol;
    state.chartTimeframe = timeframe;
    syncChartControls();
    loadMarketChart();
    const result = report.results[0];
    toast(
      result?.status === "COMPLETED"
        ? shortSymbol(symbol) + " " + timeframe + " analysis complete"
        : shortSymbol(symbol) + " " + timeframe + ": " + (result?.status || "no result")
    );
  } catch (error) {
    $("market-chart-status").textContent =
      error instanceof Error ? error.message : "Research failed.";
  } finally {
    button.removeAttribute("aria-busy");
    syncChartControls();
  }
}

function installTilt() {
  if (!finePointer || reduceMotion) return;

  const maxTilt = 5.5;
  document.querySelectorAll(".tilt-card").forEach((card) => {
    let frame = 0;

    const reset = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        card.style.transform = "";
      });
    };

    card.addEventListener("pointermove", (event) => {
      const rect = card.getBoundingClientRect();
      const nx = (event.clientX - rect.left) / Math.max(rect.width, 1) - 0.5;
      const ny = (event.clientY - rect.top) / Math.max(rect.height, 1) - 0.5;

      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rotateY = nx * maxTilt * 2;
        const rotateX = -ny * maxTilt * 2;
        card.style.transform =
          "perspective(1100px) rotateX(" +
          rotateX.toFixed(2) +
          "deg) rotateY(" +
          rotateY.toFixed(2) +
          "deg) translateZ(5px)";
      });
    });

    card.addEventListener("pointerleave", reset);
    card.addEventListener("pointercancel", reset);
  });
}

function installScrollSpy() {
  if (!("IntersectionObserver" in window)) return;

  const map = new Map([
    ["opportunities", document.querySelector('[data-jump="#opportunities"]')],
    ["evidence", document.querySelector('[data-jump="#evidence"]')],
    ["pipeline", document.querySelector('[data-jump="#pipeline"]')],
  ]);

  const activate = (button) => {
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
    button?.classList.add("active");
  };

  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];

      if (visible) activate(map.get(visible.target.id));
      else if (scrollY < 360) activate(document.querySelector('[data-jump="#top"]'));
    },
    { rootMargin: "-18% 0px -58% 0px", threshold: [0.05, 0.25, 0.5] }
  );

  ["opportunities", "evidence", "pipeline"].forEach((id) => {
    const node = document.getElementById(id);
    if (node) observer.observe(node);
  });

  addEventListener("scroll", () => {
    if (scrollY < 360) activate(document.querySelector('[data-jump="#top"]'));
  }, { passive: true });
}

async function copyRunCommand() {
  const command =
    "pnpm run dev:engine\n" +
    "# separate terminal\n" +
    "pnpm run research:universe\n" +
    "# separate terminal\n" +
    "pnpm run dashboard";

  try {
    await navigator.clipboard.writeText(command);
    toast("Launch commands copied ✦");
  } catch {
    toast("Run: pnpm run research:universe");
  }
}

function openMarketSearch() {
  const dialog = $("market-search-dialog");
  const query = $("market-search-query");
  if (!dialog || !query) return;

  marketSearchVersion += 1;
  clearTimeout(marketSearchTimer);
  selectedMarket = null;
  query.value = "";
  $("market-search-type").value = "";
  $("market-timeframe").value = "1h";
  $("market-search-results").replaceChildren();
  $("market-selection").hidden = true;
  $("market-search-status").textContent = "Aramak için en az 2 karakter yaz.";
  updateResearchAction();
  dialog.showModal();
  query.focus();
}

function scheduleMarketSearch() {
  clearTimeout(marketSearchTimer);
  marketSearchVersion += 1;
  selectedMarket = null;
  $("market-selection").hidden = true;
  $("market-search-results").replaceChildren();
  updateResearchAction();

  const query = $("market-search-query").value.trim();
  if (query.length < 2) {
    $("market-search-status").textContent = "Aramak için en az 2 karakter yaz.";
    return;
  }

  $("market-search-status").textContent = "TradingView piyasaları aranıyor…";
  marketSearchTimer = window.setTimeout(searchTradingViewMarkets, 280);
}

async function searchTradingViewMarkets() {
  const requestVersion = marketSearchVersion;
  const query = $("market-search-query").value.trim();
  const marketType = $("market-search-type").value;
  const params = new URLSearchParams({ q: query, type: marketType });

  try {
    const response = await fetch("/api/markets/search?" + params.toString(), {
      cache: "no-store"
    });
    const payload = await response.json().catch(() => ({}));
    if (requestVersion !== marketSearchVersion) return;
    if (!response.ok) throw new Error(payload.error || "TradingView araması başarısız oldu.");

    const results = Array.isArray(payload.results) ? payload.results : [];
    if (results.length === 0) {
      $("market-search-status").textContent = "Eşleşen TradingView piyasası bulunamadı.";
      return;
    }

    const list = $("market-search-results");
    list.replaceChildren();
    results.forEach((market) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "market-result";
      button.setAttribute("aria-pressed", "false");

      const id = document.createElement("strong");
      id.textContent = market.id || market.symbol || "Unknown market";
      const details = document.createElement("span");
      details.textContent = [
        market.fullExchange || market.exchange,
        market.description,
        market.type
      ].filter(Boolean).join(" · ");

      button.append(id, details);
      button.addEventListener("click", () => selectMarket(market, button));
      list.append(button);
    });

    $("market-search-status").textContent = results.length + " TradingView sonucu.";
  } catch (error) {
    if (requestVersion !== marketSearchVersion) return;
    $("market-search-status").textContent =
      error instanceof Error ? error.message : "TradingView araması başarısız oldu.";
  }
}

function selectMarket(market, button) {
  selectedMarket = market;
  document.querySelectorAll(".market-result").forEach((node) => {
    const selected = node === button;
    node.classList.toggle("selected", selected);
    node.setAttribute("aria-pressed", String(selected));
  });

  $("market-selected-label").textContent = [
    market.id || market.symbol,
    market.fullExchange || market.exchange,
    market.description
  ].filter(Boolean).join(" · ");
  $("market-selection").hidden = false;
  $("market-search-status").textContent = "Piyasa seçildi. Zaman dilimini belirleyip araştırmayı başlat.";
  updateResearchAction();

  state.chartSymbol = market.id;
  state.chartTimeframe = $("market-timeframe").value;
  syncChartControls();
  loadMarketChart();
}

function updateResearchAction() {
  const button = $("market-research-button");
  if (!button) return;
  button.disabled = !selectedMarket || button.getAttribute("aria-busy") === "true";
}

async function runOneOffResearch() {
  if (!selectedMarket) return;
  const button = $("market-research-button");
  const dialog = $("market-search-dialog");
  const timeframe = $("market-timeframe").value;
  const market = selectedMarket;

  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = "Araştırılıyor…";
  $("market-search-status").textContent = market.id + " için TradingView verisi ve araştırma yükleniyor…";

  try {
    const response = await fetch("/api/research/once", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol: market.id, timeframe })
    });
    const report = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(report.error || "Tek seferlik araştırma başarısız oldu.");
    if (!Array.isArray(report.results)) throw new Error("Araştırma raporu beklenen biçimde değil.");

    state.filter = "ALL";
    state.selectedIndex = 0;
    document.querySelectorAll(".filter").forEach((node) => {
      node.classList.toggle("active", node.dataset.filter === "ALL");
    });
    transition(() => {
      state.report = report;
      render();
    });

    dialog.close();
    const result = report.results[0];
    toast(result?.status === "COMPLETED"
      ? market.id + " araştırması tamamlandı"
      : market.id + " araştırması: " + (result?.status || "sonuç yok"));
  } catch (error) {
    $("market-search-status").textContent =
      error instanceof Error ? error.message : "Tek seferlik araştırma başarısız oldu.";
  } finally {
    button.removeAttribute("aria-busy");
    button.textContent = "Tek Seferlik Araştır";
    updateResearchAction();
  }
}

function transition(update) {
  if (reduceMotion || typeof document.startViewTransition !== "function") {
    update();
    return;
  }

  document.startViewTransition(() => update());
}

function setVerdict(node, verdict) {
  if (!node) return;
  node.className = "verdict " + verdictClass(verdict);
  node.textContent = verdict || "—";
}

function verdictClass(value) {
  if (value === "PASS") return "pass";
  if (value === "REVIEW") return "review";
  if (value === "FAIL") return "fail";
  return "neutral";
}

function statusLabel(value) {
  if (value === "NO_SIGNAL") return "NO SIGNAL";
  if (value === "ERROR") return "ERROR";
  return value || "—";
}

function prettyCheck(value) {
  return String(value || "check")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function metricDetail(check) {
  const parts = [];
  if (Number.isFinite(check.value)) parts.push("value " + formatNumber(check.value, 3));
  if (Number.isFinite(check.threshold)) parts.push("threshold " + formatNumber(check.threshold, 3));
  return parts.join(" · ") || "Deterministic validation check";
}

function exchangeName(value) {
  return String(value || "").split(":")[0] || "TradingView";
}

function shortSymbol(value) {
  const symbol = String(value || "");
  return symbol.includes(":") ? symbol.split(":").slice(1).join(":") : symbol;
}

function planetMonogram(value) {
  const cleaned = String(value || "QS").replace(/[^A-Za-z0-9]/g, "");
  return (cleaned.slice(0, 4) || "QS").toUpperCase();
}

function numberClass(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return number > 0 ? "positive" : number < 0 ? "negative" : "";
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatInteger(value) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(Number(value) || 0);
}

function formatNumber(value, digits = 2) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : "—";
}

function formatPercent(value, digits = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) + "%" : "—";
}

function formatSignedPercent(value, digits = 1) {
  const number = Number(value);
  return Number.isFinite(number)
    ? (number > 0 ? "+" : "") + number.toFixed(digits) + "%"
    : "—";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

let toastTimer;
function toast(message) {
  const node = $("toast");
  if (!node) return;
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 2400);
}
