import { afterEach, describe, expect, test } from "bun:test";

import { startVisualizationServer, type VisualizationServer } from "../src/visualization/server.ts";
import { VISUALIZATION_SCHEMA, type VisualizationGraph } from "../src/visualization/model.ts";

let running: VisualizationServer | undefined;
afterEach(() => { running?.server.stop(true); running = undefined; });

describe("dependency graph visualization server", () => {
  test("serves only the UI and bounded read-only graph API on loopback", async () => {
    running = await startVisualizationServer({ loadGraph: async () => sample("a"), openBrowser: false });
    expect(running.url).toStartWith("http://127.0.0.1:");
    const page = await fetch(running.url);
    expect(page.status).toBe(200);
    expect(await page.clone().text()).toContain("Backbone");
    expect(await page.clone().text()).toContain("Hierarchy");
    expect(await page.clone().text()).toContain("Agent contrast");
    expect(await page.text()).toContain('id="scope"');
    const styles = await (await fetch(`${running.url}/assets/styles.css`)).text();
    expect(styles).toContain("min-height: 0; overflow: hidden");
    const client = await (await fetch(`${running.url}/assets/client.js`)).text();
    expect(client).toContain("dependencyForest");
    expect(client).toContain("domainGraph");
    expect(() => new Function(client)).not.toThrow();
    const layout = await (await fetch(`${running.url}/assets/layout.js`)).text();
    expect(layout).toContain("layoutCompound");
    expect(() => new Function(layout)).not.toThrow();
    expect((await fetch(`${running.url}/assets/elk.js`)).status).toBe(200);
    expect(await (await fetch(`${running.url}/api/graph`)).json()).toEqual(sample("a"));
    expect((await fetch(`${running.url}/../../package.json`)).status).toBe(404);
    expect((await fetch(`${running.url}/api/rescan`)).status).toBe(404);
  });

  test("serializes concurrent rescans and publishes the completed snapshot", async () => {
    let calls = 0;
    running = await startVisualizationServer({
      loadGraph: async () => {
        calls += 1;
        await Bun.sleep(15);
        return sample(String(calls));
      },
      openBrowser: false,
    });
    const [left, right] = await Promise.all([
      fetch(`${running.url}/api/rescan`, { method: "POST" }),
      fetch(`${running.url}/api/rescan`, { method: "POST" }),
    ]);
    expect(calls).toBe(2);
    expect(await left.json()).toEqual(await right.json());
    expect((await (await fetch(`${running.url}/api/graph`)).json() as VisualizationGraph).digest).toBe("2".repeat(64));
  });
});

function sample(seed: string): VisualizationGraph {
  return { schema: VISUALIZATION_SCHEMA, commit: seed.repeat(40), digest: seed.repeat(64), generatedFrom: { modules: 0, edges: 0 }, nodes: [], edges: [] };
}
