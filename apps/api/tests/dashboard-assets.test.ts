import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const dashboardUrl = new URL("../../dashboard/", import.meta.url);

describe("research dashboard assets", () => {
  it("ships the cartoon 3D observatory shell and GPU fallback path", async () => {
    const [html, css, appJs, worldJs] = await Promise.all([
      readFile(new URL("index.html", dashboardUrl), "utf8"),
      readFile(new URL("styles.css", dashboardUrl), "utf8"),
      readFile(new URL("app.js", dashboardUrl), "utf8"),
      readFile(new URL("world.js", dashboardUrl), "utf8"),
    ]);

    expect(html).toContain("Swarm Observatory");
    expect(html).toContain('meta name="viewport"');
    expect(html).toContain('id="shader-world"');
    expect(html).toContain("./world.js");

    expect(css).toContain("transform-style:preserve-3d");
    expect(css).toContain("@container");
    expect(css).toContain("prefers-reduced-motion");
    expect(css).toContain("::view-transition-old(root)");
    expect(css).toContain("--positive");

    expect(appJs).toContain("/api/report");
    expect(appJs).toContain("startViewTransition");
    expect(appJs).toContain("fleet-row");
    expect(appJs).toContain("positiveHoldoutRate");

    expect(worldJs).toContain('getContext("webgl2"');
    expect(worldJs).toContain("#version 300 es");
    expect(worldJs).toContain("prefers-reduced-motion");
    expect(worldJs).toContain("no-webgl");

    expect(() => new Function(appJs)).not.toThrow();
    expect(() => new Function(worldJs)).not.toThrow();
  });
});
