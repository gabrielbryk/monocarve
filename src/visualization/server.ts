import open from "open";

// TypeScript resolves the underlying asset declarations and ignores Bun's text
// loader attribute; Bun embeds these exact bytes in bundled and compiled CLIs.
// @ts-expect-error imported as text, not as the library module it declares
import visSource from "../../node_modules/vis-network/standalone/umd/vis-network.min.js" with { type: "text" };
// @ts-expect-error Bun text asset
import visStyles from "../../node_modules/vis-network/styles/vis-network.css" with { type: "text" };
// @ts-expect-error Bun text asset
import clientSource from "./client.js" with { type: "text" };
// @ts-expect-error Bun text asset
import clientStyles from "./client.css" with { type: "text" };
import type { VisualizationGraph } from "./model.ts";

export interface VisualizationServerOptions {
  readonly loadGraph: () => Promise<VisualizationGraph>;
  readonly port?: number;
  readonly openBrowser?: boolean;
}

export interface VisualizationServer {
  readonly url: string;
  readonly server: Bun.Server<unknown>;
  readonly refresh: () => Promise<VisualizationGraph>;
}

export async function startVisualizationServer(options: VisualizationServerOptions): Promise<VisualizationServer> {
  let current = await options.loadGraph();
  let activeRefresh: Promise<VisualizationGraph> | undefined;
  const refresh = (): Promise<VisualizationGraph> => {
    activeRefresh ??= options.loadGraph().then((graph) => {
      current = graph;
      return graph;
    }).finally(() => { activeRefresh = undefined; });
    return activeRefresh;
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    routes: {
      "/": () => new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }),
      "/assets/vis.js": () => new Response(visSource, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" } }),
      "/assets/client.js": () => new Response(clientSource, { headers: { "content-type": "text/javascript; charset=utf-8" } }),
      "/assets/styles.css": () => new Response(`${visStyles}\n${clientStyles}`, { headers: { "content-type": "text/css; charset=utf-8" } }),
      "/api/graph": () => Response.json(current),
      "/api/status": () => Response.json({ schema: current.schema, commit: current.commit, digest: current.digest }),
      "/api/rescan": {
        POST: async () => {
          try {
            return Response.json(await refresh());
          } catch (error) {
            return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
          }
        },
      },
    },
    fetch: () => new Response("not found", { status: 404 }),
  });
  const url = `http://${server.hostname}:${server.port}`;
  if (options.openBrowser !== false) await open(url, { wait: false });
  return { url, server, refresh };
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dependency graph</title><link rel="stylesheet" href="/assets/styles.css"></head>
<body><header><strong>Dependency graph</strong><input id="search" type="search" placeholder="Filter paths, domains, owners…" aria-label="Filter graph">
<select id="view" aria-label="Graph view"><option value="domains">Architecture</option><option value="components">Components</option></select>
<select id="scope" aria-label="Graph scope"><option value="">All domains</option></select>
<select id="density" aria-label="Connection density"><option value="hierarchy">Hierarchy</option><option value="backbone">Backbone</option><option value="all">All connections</option></select>
<select id="contrast" aria-label="Visual contrast"><option value="high">Agent contrast</option><option value="dark">Dark</option></select>
<select id="kind" aria-label="Filter edge kind"><option value="">All edge kinds</option></select>
<button id="refresh" type="button">Rescan</button><span id="status">Loading…</span></header>
<main><div id="network" aria-label="Interactive dependency graph"></div><aside id="details"><p>Select a component to inspect its files and dependencies.</p></aside></main>
<script src="/assets/vis.js"></script><script src="/assets/client.js"></script></body></html>`;
