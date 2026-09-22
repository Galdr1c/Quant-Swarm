import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.QUANT_DASHBOARD_PORT ?? 4173);
const reportPath = resolve(process.env.QUANT_REPORT_PATH ?? ".data/universe-report.json");
const demoPath = join(root, "demo-report.json");

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/report") {
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
