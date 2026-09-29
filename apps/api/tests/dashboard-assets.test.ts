import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const dashboardUrl = new URL("../../dashboard/", import.meta.url);

describe("research dashboard assets", () => {
  it("ships the research-first command center and accessible motion fallbacks", async () => {
    const [html, css, theme, appJs, worldJs, coreSvg, iconsSvg] = await Promise.all([
      readFile(new URL("index.html", dashboardUrl), "utf8"),
      readFile(new URL("styles.css", dashboardUrl), "utf8"),
      readFile(new URL("theme-v2.css", dashboardUrl), "utf8"),
      readFile(new URL("app.js", dashboardUrl), "utf8"),
      readFile(new URL("world.js", dashboardUrl), "utf8"),
      readFile(new URL("assets/swarm-core.svg", dashboardUrl), "utf8"),
      readFile(new URL("assets/icons.svg", dashboardUrl), "utf8"),
    ]);

    expect(html).toContain("Research the market.");
    expect(html).toContain('meta name="viewport"');
    expect(html).toContain('id="shader-world"');
    expect(html).toContain("./theme-v2.css");
    expect(html).toContain("./assets/swarm-core.svg");
    expect(html).toContain('id="core-label"');

    expect(css).toContain("prefers-reduced-motion");
    expect(theme).toContain("--v2-cyan");
    expect(theme).toContain(".swarm-core");
    expect(theme).toContain("font-size:12px");
    expect(theme).toContain("prefers-reduced-motion");

    expect(appJs).toContain("/api/report");
    expect(appJs).toContain("startViewTransition");
    expect(appJs).toContain("fleet-row");
    expect(appJs).toContain("positiveHoldoutRate");
    expect(appJs).toContain("const maxTilt = 2.2");

    expect(worldJs).toContain('getContext("webgl2"');
    expect(worldJs).toContain("#version 300 es");
    expect(worldJs).toContain("prefers-reduced-motion");
    expect(worldJs).toContain("no-webgl");

    expect(coreSvg).toContain('viewBox="0 0 160 160"');
    expect(iconsSvg).toContain('id="icon-shield"');

    expect(() => new Function(appJs)).not.toThrow();
    expect(() => new Function(worldJs)).not.toThrow();
  });
});
