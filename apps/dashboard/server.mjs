import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { searchTradingViewMarkets } from "../../packages/market-data/dist/tradingview.js";

const root = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(root, "../..");
const port = Number(process.env.QUANT_DASHBOARD_PORT ?? 4173);
const reportPath = resolve(process.env.QUANT_REPORT_PATH ?? ".data/universe-report.json");
const demoPath = join(root, "demo-report.json");
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
const supportedTimeframes = new Set(["15m", "1h", "4h", "1d"]);

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
    return sendJson(res, 400, { error: "Choose one of the supported timeframes: 15m, 1h, 4h, 1d." });
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
