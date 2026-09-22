import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const dashboardUrl = new URL("../../dashboard/", import.meta.url);

describe("research dashboard assets", () => {
  it("ships a responsive report-driven dashboard shell", async () => {
    const [html, css, js] = await Promise.all([
      readFile(new URL("index.html", dashboardUrl), "utf8"),
      readFile(new URL("styles.css", dashboardUrl), "utf8"),
      readFile(new URL("app.js", dashboardUrl), "utf8"),
    ]);

    expect(html).toContain("Research Command Center");
    expect(html).toContain('meta name="viewport"');
    expect(css).toContain("@media");
    expect(css).toContain("--positive");
    expect(js).toContain("/api/report");
    expect(js).toContain("positiveHoldoutRate");
  });
});
