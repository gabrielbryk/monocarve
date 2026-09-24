/**
 * Acceptance test 4 from the seven-seam plan: a configured post-journal
 * preparer changes its declared output before gates run, when its trigger
 * only matches a rewritten *document* — not a moved production source.
 *
 * `generatedFilesFor` (src/plan/build-support.ts) was widened to test
 * preparer triggers against `[...production, ...documents]` instead of just
 * `production`. These cases prove the widening fires exactly on the new
 * surface it was meant to cover, does not turn every preparer into an
 * always-fires preparer, and leaves the two pre-existing behaviours (empty
 * trigger list, and a trigger matching a moved production path) unchanged.
 *
 * Case 1 drives the REAL pipeline (`buildPlanSync`) rather than calling
 * `generatedFilesFor` by hand: `documents` only reaches it because
 * `buildManifest` (src/plan/build.ts) reads the `rewrite-path-reference`
 * operations back off the compiled journal and feeds their `.file`s in. A
 * unit call that passes `documents` directly would still pass even if the
 * production call site never wired it — which is exactly the defect this
 * case exists to catch.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.ts";
import { scanDependencyGraph } from "../src/graph/cruiser.ts";
import { buildPlanSync, generatedFilesFor } from "../src/plan/build.ts";
import { WorkspaceContext } from "../src/plan/context.ts";
import { buildPortfolio } from "../src/portfolio/rank.ts";
import { simulatePlan } from "../src/transaction/simulate.ts";
import { cleanupFixtures, fixtureConfig, fixtureGit, fixtureRepo, scratchDirectory } from "./support/fixture-repo.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "../fixtures/basic-monorepo");
const REAL_CHART = "apps/web/src/widgets/chart.ts";
const REAL_DOC = "docs/chart-notes.md";
const REAL_OUTPUT = "doc-ratchet.txt";

/**
 * A standalone copy of the `basic-monorepo` fixture, configured so that
 * `apps/web/src/widgets/chart.ts` (the module the extraction moves) is also
 * named — outside the import graph — by a markdown document that
 * `pathReferenceRewrites` is configured to scan, and a post-journal preparer
 * whose trigger matches only that document's path.
 */
function realPipelineWorkspace(): string {
  const root = join(scratchDirectory(), "workspace");
  cpSync(FIXTURE, root, { recursive: true });
  rmSync(join(root, ".monocarve"), { recursive: true, force: true });

  mkdirSync(dirname(join(root, REAL_DOC)), { recursive: true });
  writeFileSync(join(root, REAL_DOC), `See \`${REAL_CHART}\` for the chart widget.\n`);

  const configPath = join(root, "monocarve.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  config.pathReferenceRewrites = { enabled: true, roots: [{ root: "docs", extensions: [".md"], mode: "exact-path-token" }] };
  config.postJournalPreparers = [
    {
      id: "doc-ratchet",
      phase: "after-journal-before-gates",
      command: `printf ok > ${REAL_OUTPUT}`,
      outputs: [REAL_OUTPUT],
      // Matches only the rewritten document, never the moved production
      // source: this is the exact capability that was unreachable dead code.
      triggers: [`^${REAL_DOC}$`],
      verify: `grep -q ok ${REAL_OUTPUT}`,
    },
  ];
  // A workspace gate that reads the preparer's output: gates can only pass
  // if the preparer ran, and ran before the gates phase — the "before
  // gates" half of the acceptance test, not just "it ran at some point".
  const gates = config.gates as { workspace: string[] };
  gates.workspace = [...gates.workspace, `test -s ${REAL_OUTPUT} && grep -q ok ${REAL_OUTPUT}`];
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  fixtureGit(root, "init", "-q", "-b", "work");
  fixtureGit(root, "config", "user.email", "fixture@example.invalid");
  fixtureGit(root, "config", "user.name", "Monocarve Fixture");
  fixtureGit(root, "config", "commit.gpgsign", "false");
  fixtureGit(root, "add", "-A");
  fixtureGit(root, "commit", "-qm", "test: seed workspace");
  return root;
}

const DONOR = "apps/api/src/widget.ts";
const TARGET = "libs/analytics/src/widget.ts";
const DOCUMENT = "docs/widget-notes.md";
const OUTPUT = "doc-ratchet.txt";

function files() {
  return {
    "package.json": '{"name":"fixture-workspace","private":true,"type":"module"}\n',
    "apps/api/tsconfig.json": '{"include":["src"]}\n',
    [DONOR]: "export const widgetValue = 1;\n",
    [DOCUMENT]: "See apps/api/src/widget.ts for details.\n",
  };
}

function preparer(triggers: string[]) {
  return {
    id: "doc-ratchet",
    phase: "after-journal-before-gates" as const,
    command: `printf ok > ${OUTPUT}`,
    outputs: [OUTPUT],
    triggers,
    verify: `grep -q ok ${OUTPUT}`,
  };
}

describe("post-journal preparer trigger matches a rewritten document", () => {
  afterEach(cleanupFixtures);

  test("1. a trigger matching only a rewritten document fires, and the preparer's output regenerates before gates run", async () => {
    const root = realPipelineWorkspace();
    const { config } = await loadConfig({ cwd: root });
    const graph = await scanDependencyGraph({ config, rootDir: root, noCache: true });
    const candidate = buildPortfolio({ config, graph }).candidates.find((entry) => entry.eligible && entry.files.includes(REAL_CHART));
    expect(candidate).toBeDefined();

    const manifest = buildPlanSync({ config, rootDir: root, graph, candidate: candidate!, baselineCommit: graph.commit!, packageName: "@acme/chart-docref" });

    // Proves the wiring end to end: the compiled journal actually contains a
    // rewrite-path-reference operation naming the document (not just that
    // the config was accepted), and the compiled manifest's generatedFiles —
    // produced by the production call site in build.ts, not a hand-passed
    // `documents` argument — contains the preparer's output.
    const rewriteOperation = manifest.operations.find((operation) => operation.kind === "rewrite-path-reference" && operation.file === REAL_DOC);
    expect(rewriteOperation).toBeDefined();
    expect(manifest.generatedFiles).toContainEqual(expect.objectContaining({ path: REAL_OUTPUT, preparerId: "doc-ratchet", regenerateOnApply: true }));

    const result = await simulatePlan({ config, rootDir: root, manifest });

    expect(result.failure).toBeUndefined();
    expect(result.ok).toBe(true);
    // The gate command reads REAL_OUTPUT's content; it can only pass if the
    // preparer ran, and ran before the gates phase — this is the "before
    // gates" half of the proof, not just "it ran at some point".
    expect(result.gates.every((gate) => gate.exitCode === 0)).toBe(true);
    expect(result.regeneration?.artifacts).toContainEqual(expect.objectContaining({ path: REAL_OUTPUT, changed: true }));
    // The real checkout is untouched — this was all inside the simulation.
    expect(existsSync(join(root, REAL_OUTPUT))).toBe(false);
  }, 120_000);

  test("2. a trigger matching neither a moved source nor a rewritten document does not fire", () => {
    const root = fixtureRepo(files());
    const config = fixtureConfig(root, { postJournalPreparers: [preparer(["^apps/other/"])] });
    const context = new WorkspaceContext(config, root);

    // Widening the trigger surface to include documents must not make this
    // preparer — whose trigger matches neither the moved source nor the
    // rewritten document — start firing anyway.
    const generatedFiles = generatedFilesFor(config, context, [DONOR], [TARGET], [DOCUMENT]);
    expect(generatedFiles.map((file) => file.path)).not.toContain(OUTPUT);
  });

  test("3a. an empty trigger list still means every extraction, unchanged", () => {
    const root = fixtureRepo(files());
    const config = fixtureConfig(root, { postJournalPreparers: [preparer([])] });
    const context = new WorkspaceContext(config, root);

    const generatedFiles = generatedFilesFor(config, context, [DONOR], [TARGET]);
    expect(generatedFiles).toContainEqual(expect.objectContaining({ path: OUTPUT, preparerId: "doc-ratchet" }));
  });

  test("3b. a trigger matching a moved production path still fires exactly as before, with no documents passed", () => {
    const root = fixtureRepo(files());
    const config = fixtureConfig(root, { postJournalPreparers: [preparer([`^${DONOR}$`])] });
    const context = new WorkspaceContext(config, root);

    const generatedFiles = generatedFilesFor(config, context, [DONOR], [TARGET]);
    expect(generatedFiles).toContainEqual(expect.objectContaining({ path: OUTPUT, preparerId: "doc-ratchet" }));
  });
});
