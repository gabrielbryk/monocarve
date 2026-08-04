import { afterAll, expect, test } from "bun:test";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, type MonocarveConfig } from "../src/config.ts";
import { scanDependencyGraph } from "../src/graph/cruiser.ts";
import { buildPlanSync, serializeManifest } from "../src/plan/build.ts";
import { refreshExtractionPlan } from "../src/plan/refresh.ts";
import { buildPortfolio } from "../src/portfolio/rank.ts";
import type { PortfolioCandidate } from "../src/portfolio/types.ts";
import { cleanupFixtures, fixtureGit, scratchDirectory, write } from "./support/fixture-repo.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "../fixtures/basic-monorepo");
const SOURCE = "apps/web/src/widgets/chart.ts";

afterAll(cleanupFixtures);

async function plannedWorkspace() {
  const root = join(scratchDirectory(), "refresh-workspace");
  cpSync(FIXTURE, root, { recursive: true });
  fixtureGit(root, "init", "-q", "-b", "refresh-fixture");
  fixtureGit(root, "config", "user.email", "fixture@example.invalid");
  fixtureGit(root, "config", "user.name", "Monocarve Fixture");
  fixtureGit(root, "config", "commit.gpgsign", "false");
  fixtureGit(root, "add", "-A");
  fixtureGit(root, "commit", "-qm", "test: seed refresh fixture");
  const { config } = await loadConfig({ cwd: root });
  const graph = await scanDependencyGraph({ config, rootDir: root, noCache: true });
  const candidate = candidateFor(config, graph);
  const manifest = buildPlanSync({ config, rootDir: root, graph, candidate, baselineCommit: graph.commit!, packageName: "@acme/chart" });
  return { root, config, manifest };
}

function candidateFor(config: MonocarveConfig, graph: Awaited<ReturnType<typeof scanDependencyGraph>>): PortfolioCandidate {
  const candidate = buildPortfolio({ config, graph }).candidates.find((entry) => entry.files.includes(SOURCE));
  if (candidate === undefined) throw new Error("chart candidate missing");
  return candidate;
}

async function currentInputs(root: string, config: MonocarveConfig) {
  const graph = await scanDependencyGraph({ config, rootDir: root, noCache: true });
  return { graph, resolveCandidate: () => candidateFor(config, graph) };
}

test("refreshes baseline provenance at HEAD without inventing a semantic change", async () => {
  const { root, config, manifest } = await plannedWorkspace();
  write(root, "docs/unrelated.md", "unrelated\n");
  fixtureGit(root, "add", "-A");
  fixtureGit(root, "commit", "-qm", "docs: advance baseline");
  const current = await currentInputs(root, config);
  const manifestRoot = scratchDirectory();
  write(manifestRoot, "refresh.json", serializeManifest(manifest));

  const result = refreshExtractionPlan({ manifest: join(manifestRoot, "refresh.json"), config, rootDir: root, ...current });

  expect(result.previousBaselineCommit).toBe(manifest.baselineCommit);
  expect(result.currentBaselineCommit).not.toBe(manifest.baselineCommit);
  expect(result.manifest.baselineCommit).toBe(result.currentBaselineCommit);
  expect(result.semanticDiff).toEqual([]);
});

test("refuses changed source bytes even when the path closure is unchanged", async () => {
  const { root, config, manifest } = await plannedWorkspace();
  writeFileSync(join(root, SOURCE), `${readFileSync(join(root, SOURCE), "utf8")}\n`);
  fixtureGit(root, "add", "-A");
  fixtureGit(root, "commit", "-qm", "test: alter donor bytes");
  const current = await currentInputs(root, config);

  expect(() => refreshExtractionPlan({ manifest, config, rootDir: root, ...current })).toThrow("source blobs changed");
});

test("refuses an uncommitted workspace instead of claiming to compile HEAD", async () => {
  const { root, config, manifest } = await plannedWorkspace();
  write(root, "docs/uncommitted.md", "not at HEAD\n");
  const graph = await scanDependencyGraph({ config, rootDir: root, noCache: true });

  expect(() => refreshExtractionPlan({
    manifest,
    config,
    rootDir: root,
    graph,
    resolveCandidate: () => candidateFor(config, graph),
  })).toThrow("dirty workspace");
});

test("refuses target identity drift from current configuration", async () => {
  const { root, config, manifest } = await plannedWorkspace();
  write(root, "docs/unrelated.md", "unrelated\n");
  fixtureGit(root, "add", "-A");
  fixtureGit(root, "commit", "-qm", "docs: advance baseline");
  const changed = { ...config, scaffoldTemplates: { ...config.scaffoldTemplates, entrypoint: "src/main.ts" } };
  const current = await currentInputs(root, changed);

  expect(() => refreshExtractionPlan({ manifest, config: changed, rootDir: root, ...current })).toThrow("target identity changed");
});

test("refuses execution-policy drift from current configuration", async () => {
  const { root, config, manifest } = await plannedWorkspace();
  write(root, "docs/unrelated.md", "unrelated\n");
  fixtureGit(root, "add", "-A");
  fixtureGit(root, "commit", "-qm", "docs: advance baseline");
  const changed = { ...config, gates: { ...config.gates, workspace: ["false"] } };
  const current = await currentInputs(root, changed);

  expect(() => refreshExtractionPlan({ manifest, config: changed, rootDir: root, ...current })).toThrow("configured gates changed");
});
