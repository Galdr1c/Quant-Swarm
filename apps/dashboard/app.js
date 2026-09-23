const state = {
  report: null,
  filter: "ALL",
  selectedIndex: 0,
};

let marketSearchTimer = null;
let marketSearchVersion = 0;
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
  $("market-timeframe")?.addEventListener("change", updateResearchAction);
  $("market-research-button")?.addEventListener("click", runOneOffResearch);

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
    drawEquity([]);
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
  drawEquity(row.equityCurve || []);
}

function renderValidation(row) {
  const root = $("validation-list");
  if (!root) return;
  root.innerHTML = "";

  const checks = row?.checks?.slice(0, 6) || [];
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
    detail("Holdout PF", formatNumber(final?.profitFactor, 2)) +
    detail("Trades", formatInteger(final?.totalTrades || 0)) +
    '</div><div class="detail-note"><strong>' +
    escapeHtml(row.selectedStrategy?.name || statusLabel(row.status)) +
    "</strong><br>" +
    (row.runId ? "Run: " + escapeHtml(row.runId) + "<br>" : "") +
    "The cartoon fleet is decorative. Ranking still uses verdict first, then untouched final-holdout Sharpe and return — never a promise of future profitability.</div>";
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

function drawEquity(values) {
  const line = $("line-path");
  const area = $("area-path");
  if (!line || !area) return;

  if (!Array.isArray(values) || values.length < 2) {
    line.setAttribute("d", "");
    area.setAttribute("d", "");
    return;
  }

  const finite = values.map(Number).filter(Number.isFinite);
  if (finite.length < 2) return;

  const width = 760;
  const top = 22;
  const bottom = 228;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const range = Math.max(max - min, Math.abs(max) * 0.005, 1);

  const points = finite.map((value, index) => [
    (index / (finite.length - 1)) * width,
    bottom - ((value - min) / range) * (bottom - top),
  ]);

  const path = points
    .map(([x, y], index) => (index === 0 ? "M " : "L ") + x.toFixed(2) + " " + y.toFixed(2))
    .join(" ");

  line.setAttribute("d", path);
  area.setAttribute("d", path + " L " + width + " " + bottom + " L 0 " + bottom + " Z");

  if (!reduceMotion && typeof line.animate === "function") {
    const length = line.getTotalLength?.() || 0;
    if (length > 0) {
      line.style.strokeDasharray = String(length);
      line.style.strokeDashoffset = String(length);
      line.animate(
        [{ strokeDashoffset: length }, { strokeDashoffset: 0 }],
        { duration: 900, easing: "cubic-bezier(.16,.84,.24,1)", fill: "forwards" }
      );
    }
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
