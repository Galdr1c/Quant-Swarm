import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  TradingViewMarketDataProvider,
  searchTradingViewMarkets
} from "../../packages/market-data/dist/tradingview.js";
import {
  JsonlTradeLedger,
  JsonPaperDayStateStore,
  PaperExecutor,
  rebuildPaperPortfolio
} from "../../packages/trade-ledger/dist/index.js";
import {
  DEFAULT_RISK_LIMITS,
  RiskEngine
} from "../../packages/risk-contracts/dist/index.js";

const root = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(root, "../..");
const port = Number(process.env.QUANT_DASHBOARD_PORT ?? 4173);
const reportPath = resolve(process.env.QUANT_REPORT_PATH ?? ".data/universe-report.json");
const demoPath = join(root, "demo-report.json");
const tradesPath = resolve(process.env.QUANT_TRADES_PATH ?? ".data/trades.jsonl");
const tradeLedger = new JsonlTradeLedger(tradesPath);
const paperInitialCash = positiveNumber(process.env.PAPER_INITIAL_CASH, 100_000);
const paperSlippageBps = nonNegativeNumber(process.env.PAPER_SLIPPAGE_BPS, 2);
const paperFeeBps = nonNegativeNumber(process.env.PAPER_FEE_BPS, 5);
const paperDayStatePath = resolve(
  process.env.PAPER_DAY_STATE_PATH ?? ".data/paper-day-state.json"
);
const paperDayState = new JsonPaperDayStateStore(paperDayStatePath);
const paperExecutor = new PaperExecutor(tradeLedger, {
  slippageBps: paperSlippageBps,
  feeBps: paperFeeBps
});
const paperRiskEngine = new RiskEngine(DEFAULT_RISK_LIMITS, "paper");
const researchRunnerPath = join(repoRoot, "apps", "api", "dist", "universe.js");
const supportedMarketTypes = new Set([
  "",
  "stock",
  "futures",
  "forex",
  "cfd",
  "crypto",
  "index",
  "economic"
]);
const supportedTimeframes = new Set(["5m", "15m", "1h", "4h", "1d"]);
const configuredPaperMarkTimeframe =
  (process.env.PAPER_MARK_TIMEFRAME ?? "5m").trim();
const paperMarkTimeframe = supportedTimeframes.has(configuredPaperMarkTimeframe)
  ? configuredPaperMarkTimeframe
  : "5m";
let paperOrderQueue = Promise.resolve();
const marketDataProvider = new TradingViewMarketDataProvider({
  token: process.env.TRADINGVIEW_SESSION_ID,
  signature: process.env.TRADINGVIEW_SESSION_SIGNATURE,
  session: process.env.TRADINGVIEW_MARKET_SESSION === "extended" ? "extended" : "regular",
  includeCurrentHistoricalBar: false
});

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/api/markets/search") {
      if (req.method !== "GET") {
        return sendJson(res, 405, { error: "Use GET to search TradingView markets." });
      }
      return searchMarkets(url, res);
    }

    if (url.pathname === "/api/market/history") {
      if (req.method !== "GET") {
        return sendJson(res, 405, { error: "Use GET to load market history." });
      }
      return marketHistory(url, res);
    }

    if (url.pathname === "/api/paper/order") {
      if (req.method !== "POST") {
        return sendJson(res, 405, { error: "Use POST to place a paper order." });
      }
      return paperOrder(req, res);
    }

    if (url.pathname === "/api/portfolio") {
      if (req.method !== "GET") {
        return sendJson(res, 405, { error: "Use GET to read the paper portfolio." });
      }
      return paperPortfolio(url, res);
    }

    if (url.pathname === "/api/trades") {
      if (req.method !== "GET") {
        return sendJson(res, 405, { error: "Use GET to read recorded trades." });
      }
      return recordedTrades(url, res);
    }

    if (url.pathname === "/api/research/once") {
      if (req.method !== "POST") {
        return sendJson(res, 405, { error: "Use POST to start one-off research." });
      }
      return researchOnce(req, res);
    }

    if (url.pathname === "/api/report") {
      if (req.method !== "GET") {
        return sendJson(res, 405, { error: "Use GET to read the current report." });
      }
      const report = await readJsonWithFallback(reportPath, demoPath);
      return send(res, 200, "application/json; charset=utf-8", JSON.stringify(report));
    }

    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const safePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
    const filePath = join(root, safePath);
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    const body = await readFile(filePath);
    return send(res, 200, types[extname(filePath)] ?? "application/octet-stream", body);
  } catch {
    return send(res, 404, "text/plain; charset=utf-8", "Not found");
  }
});

async function searchMarkets(url, res) {
  const query = (url.searchParams.get("q") ?? "").trim();
  const marketType = (url.searchParams.get("type") ?? "").trim().toLowerCase();

  if (query.length < 2) {
    return sendJson(res, 400, { error: "Enter at least two characters to search." });
  }
  if (!supportedMarketTypes.has(marketType)) {
    return sendJson(res, 400, { error: "Unsupported TradingView market type." });
  }

  try {
    const results = await searchTradingViewMarkets(query, marketType, 0);
    return sendJson(res, 200, { results: results.slice(0, 20) });
  } catch (error) {
    return sendJson(res, 502, {
      error: errorMessage(error, "TradingView market search failed.")
    });
  }
}

async function marketHistory(url, res) {
  const symbol = normalizeSearchResultId(url.searchParams.get("symbol"));
  const timeframe = (url.searchParams.get("timeframe") ?? "").trim();
  const rawLimit = Number(url.searchParams.get("limit") ?? 300);
  const limit = Number.isInteger(rawLimit) ? Math.min(1000, Math.max(50, rawLimit)) : 300;

  if (!symbol) {
    return sendJson(res, 400, { error: "Choose a valid exchange-qualified TradingView market." });
  }
  if (!supportedTimeframes.has(timeframe)) {
    return sendJson(res, 400, { error: "Unsupported timeframe. Use 5m, 15m, 1h, 4h or 1d." });
  }

  try {
    const candles = await marketDataProvider.getHistoricalOHLCV(symbol, timeframe, limit);
    return sendJson(res, 200, { symbol, timeframe, candles });
  } catch (error) {
    return sendJson(res, 502, {
      error: errorMessage(error, "TradingView history failed.")
    });
  }
}

async function paperOrder(req, res) {
  let payload;
  try {
    payload = await readJsonRequest(req);
  } catch (error) {
    const status = error?.statusCode === 413 ? 413 : 400;
    return sendJson(res, status, { error: errorMessage(error, "Invalid request body.") });
  }

  const symbol = normalizeSearchResultId(payload?.symbol);
  const side = payload?.side === "BUY" || payload?.side === "SELL" ? payload.side : null;
  const quantity = Number(payload?.quantity);
  const timeframe =
    typeof payload?.timeframe === "string" ? payload.timeframe.trim() : "";
  const strategyId =
    typeof payload?.strategyId === "string" && payload.strategyId.trim()
      ? payload.strategyId.trim().slice(0, 128)
      : "manual-paper";

  if (!symbol) {
    return sendJson(res, 400, { error: "Choose a valid exchange-qualified market." });
  }
  if (!side) {
    return sendJson(res, 400, { error: "Paper order side must be BUY or SELL." });
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return sendJson(res, 400, { error: "Paper order quantity must be positive." });
  }
  if (!supportedTimeframes.has(timeframe)) {
    return sendJson(res, 400, {
      error: "Paper order timeframe must be one of: 5m, 15m, 1h, 4h, 1d."
    });
  }

  try {
    const response = await serializePaperOrder(async () => {
      const candles = await marketDataProvider.getHistoricalOHLCV(symbol, timeframe, 50);
      const referenceCandle = candles.at(-1);
      const price = Number(referenceCandle?.close);
      if (!referenceCandle || !Number.isFinite(price) || price <= 0) {
        throw paperMarketDataError(
          "TradingView returned no valid closed price for paper execution."
        );
      }

      const currentPortfolio = await rebuildPaperPortfolio(tradeLedger, paperInitialCash);
      const marks = await loadOpenPositionMarks(currentPortfolio, {
        [symbol]: price
      });
      const currentSnapshot = currentPortfolio.snapshot(marks);
      const dayState = await paperDayState.getOrCreate(currentSnapshot.equity);
      const order = {
        symbol,
        side,
        quantity,
        price,
        leverage: 1,
        strategyId,
        reduceOnly:
          typeof payload?.reduceOnly === "boolean"
            ? payload.reduceOnly
            : side === "SELL"
      };
      const result = await paperExecutor.executeFromLedger(
        order,
        paperInitialCash,
        paperRiskEngine,
        marks,
        dayState.dayStartEquity,
        dayState.peakEquity
      );

      const portfolio = result.portfolio;
      const updatedDayState = portfolio
        ? await paperDayState.getOrCreate(portfolio.equity)
        : dayState;
      const dailyPnl = portfolio
        ? portfolio.equity - dayState.dayStartEquity
        : currentSnapshot.equity - dayState.dayStartEquity;
      const dailyPnlPct = (dailyPnl / dayState.dayStartEquity) * 100;
      const body = {
        ...(result.fill ? { fill: result.fill } : {}),
        risk: result.risk,
        portfolio,
        dayState: updatedDayState,
        dailyPnl,
        dailyPnlPct,
        markTimeframe: paperMarkTimeframe,
        referenceCandle: {
          timeframe,
          timestamp: referenceCandle.timestamp,
          close: price
        }
      };

      return {
        status: result.risk.approved ? 201 : 409,
        body: result.risk.approved
          ? body
          : { error: "Paper order rejected by risk engine.", ...body }
      };
    });

    return sendJson(res, response.status, response.body);
  } catch (error) {
    const status = error?.statusCode === 502 ? 502 : 400;
    return sendJson(res, status, {
      error: errorMessage(error, "Paper order could not be settled.")
    });
  }
}

async function paperPortfolio(url, res) {
  const symbol = normalizeSearchResultId(url.searchParams.get("symbol"));

  try {
    const portfolio = await rebuildPaperPortfolio(tradeLedger, paperInitialCash);
    const marks = await loadOpenPositionMarks(portfolio);
    const rawSnapshot = portfolio.snapshot(marks);
    const dayState = await paperDayState.getOrCreate(rawSnapshot.equity);
    const snapshot = portfolio.snapshot(marks, dayState.peakEquity);
    const dayStartEquity = dayState.dayStartEquity;
    const dailyPnl = snapshot.equity - dayStartEquity;
    return sendJson(res, 200, {
      ...snapshot,
      positions: snapshot.positions,
      dayStartEquity,
      dailyPnl,
      dailyPnlPct: dayStartEquity > 0 ? (dailyPnl / dayStartEquity) * 100 : 0,
      markTimeframe: paperMarkTimeframe,
      markSymbol: symbol,
      markPrice: symbol ? marks[symbol] ?? null : null
    });
  } catch (error) {
    const status = error?.statusCode === 502 ? 502 : 500;
    return sendJson(res, status, {
      error: errorMessage(error, "Could not rebuild paper portfolio.")
    });
  }
}

async function loadOpenPositionMarks(portfolio, overrides = {}) {
  const positions = portfolio.snapshot().positions;
  const marks = { ...overrides };
  const missingSymbols = positions
    .map((position) => position.symbol)
    .filter((symbol) => !Number.isFinite(Number(marks[symbol])));

  await Promise.all(
    missingSymbols.map(async (symbol) => {
      try {
        const candles = await marketDataProvider.getHistoricalOHLCV(
          symbol,
          paperMarkTimeframe,
          50
        );
        const latest = candles.at(-1);
        const price = Number(latest?.close);
        if (!latest || !Number.isFinite(price) || price <= 0) {
          throw new Error("no valid closed candle");
        }
        marks[symbol] = price;
      } catch (error) {
        throw paperMarketDataError(
          "Could not mark open paper position " + symbol + ": " +
          errorMessage(error, "TradingView mark failed.")
        );
      }
    })
  );

  return marks;
}

async function serializePaperOrder(task) {
  let release;
  const previous = paperOrderQueue;
  paperOrderQueue = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}

function paperMarketDataError(message) {
  const error = new Error(message);
  error.statusCode = 502;
  return error;
}

async function recordedTrades(url, res) {
  const symbol = normalizeSearchResultId(url.searchParams.get("symbol"));
  if (!symbol) {
    return sendJson(res, 400, { error: "Choose a valid exchange-qualified TradingView market." });
  }

  try {
    const trades = (await tradeLedger.list(symbol)).map((trade) => ({
      id: trade.id,
      symbol: trade.symbol,
      mode: trade.mode,
      side: trade.side,
      timestamp: trade.timestamp,
      price: trade.price,
      quantity: trade.quantity,
      strategyId: trade.strategyId,
      source: trade.source,
      fee: trade.fee
    }));
    return sendJson(res, 200, { symbol, trades });
  } catch (error) {
    return sendJson(res, 500, {
      error: errorMessage(error, "Could not read recorded trades.")
    });
  }
}

async function researchOnce(req, res) {
  let payload;
  try {
    payload = await readJsonRequest(req);
  } catch (error) {
    const status = error?.statusCode === 413 ? 413 : 400;
    return sendJson(res, status, { error: errorMessage(error, "Invalid request body.") });
  }

  const symbol = normalizeSearchResultId(payload?.symbol);
  const timeframe = typeof payload?.timeframe === "string"
    ? payload.timeframe.trim()
    : "";
  if (!symbol) {
    return sendJson(res, 400, { error: "Choose a valid exchange-qualified TradingView market." });
  }
  if (!supportedTimeframes.has(timeframe)) {
    return sendJson(res, 400, { error: "Choose one of the supported timeframes: 5m, 15m, 1h, 4h, 1d." });
  }

  const dataDirectory = join(repoRoot, ".data");
  const temporaryReportPath = join(dataDirectory, ".one-off-" + randomUUID() + ".json");

  try {
    await mkdir(dataDirectory, { recursive: true });
    await runResearchRunner(symbol, timeframe, temporaryReportPath);
    const report = JSON.parse(await readFile(temporaryReportPath, "utf8"));
    return sendJson(res, 200, report);
  } catch (error) {
    return sendJson(res, 502, {
      error: errorMessage(error, "One-off research failed.")
    });
  } finally {
    await rm(temporaryReportPath, { force: true }).catch(() => undefined);
  }
}

function runResearchRunner(symbol, timeframe, temporaryReportPath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [researchRunnerPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        QUANT_ENGINE_URL: process.env.QUANT_ENGINE_URL ?? "http://127.0.0.1:8420",
        RESEARCH_PROVIDERS: process.env.RESEARCH_PROVIDERS || "mock,mock,mock",
        UNIVERSE_SUBSCRIPTIONS: symbol + ":" + timeframe,
        UNIVERSE_REPORT_PATH: temporaryReportPath
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(rejectPromise, new Error("Research timed out after 180 seconds."));
    }, 180_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-12_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-12_000);
    });
    child.once("error", (error) => finish(rejectPromise, error));
    child.once("close", (code, signal) => {
      if (code === 0) {
        return finish(resolvePromise, { stdout, stderr });
      }
      const detail = stderr.trim() || stdout.trim();
      const reason = detail || "Research process exited with code " + (code ?? signal) + ".";
      finish(rejectPromise, new Error(reason));
    });
  });
}

function normalizeSearchResultId(value) {
  if (typeof value !== "string") return null;
  const symbol = value.trim().toUpperCase();
  return /^[A-Z0-9_.-]+:[A-Z0-9_.!/@+=-]+$/.test(symbol) ? symbol : null;
}

async function readJsonRequest(req) {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of req) {
    byteLength += Buffer.byteLength(chunk);
    if (byteLength > 8_192) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function errorMessage(error, fallback) {
  return error instanceof Error && error.message
    ? error.message.slice(0, 2_000)
    : fallback;
}

server.listen(port, "127.0.0.1", () => {
  console.log("[dashboard] http://127.0.0.1:" + port);
  console.log("[dashboard] report=" + reportPath);
});

async function readJsonWithFallback(primary, fallback) {
  try {
    return JSON.parse(await readFile(primary, "utf8"));
  } catch {
    if (!fallback) return [];
    return JSON.parse(await readFile(fallback, "utf8"));
  }
}

function send(res, status, contentType, body) {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(body);
}

function sendJson(res, status, value) {
  return send(res, status, "application/json; charset=utf-8", JSON.stringify(value));
}
