/**
 * Array order outside `src/plan/`: the comparators whose output reaches
 * manifest bytes before the plan builder ever sees it.
 *
 * `test/plan-ordering.test.ts` covers the arrays the builder sorts itself.
 * Two more are sorted upstream of it and land in the same bytes:
 *
 *  - `graph.unresolved` (`src/graph/build.ts`), which `graphDigest` hashes *in
 *    array order* into `manifest.graphDigest`;
 *  - `candidate.rewriteEscapes` (`classifyEscapes`, `src/portfolio/containment.ts`),
 *    which the builder groups per file into the `rewrites` array of a
 *    `move-with-rewrite` operation.
 *
 * Sorting either with `localeCompare` makes the plan's bytes a function of the
 * machine's ICU data and its default locale, neither of which is an input to a
 * plan, so the determinism invariant ("same repo + same commit + same config ⇒
 * byte-identical plan") quietly stops holding across machines. Neither array is
 * populated by the pristine fixture, which is exactly why nothing caught it:
 * `unresolved` needs an import that resolves to nothing, and a `rewrites` array
 * long enough for order to matter needs one file with two escapes.
 *
 * A failure looks like: `manifest.graphDigest` coming back as the digest of the
 * *collated* `unresolved` array rather than the code-unit one — a different plan
 * for the same commit on a machine with different ICU data — or a
 * `move-with-rewrite` whose serialized `rewrites` list `.../ledger.ts` before
 * `.../Money.ts`.
 *
 * `localeCompare`'s default-locale behaviour cannot be steered from inside a bun
 * test, so nothing here tries to. Instead every case asserts the exact expected
 * order and is paired with a control asserting that this machine's collator
 * really does disagree with it; if a future ICU ever made the two agree, the
 * control fails loudly rather than the case passing vacuously.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pnpmAdapter } from "../src/adapters/pnpm.ts";
import { loadConfig } from "../src/config.ts";
import { scanDependencyGraph } from "../src/graph/cruiser.ts";
import type { DependencyGraph, UnresolvedReference } from "../src/graph/model.ts";
import { buildPlanSync, graphDigest, serializeManifest } from "../src/plan/build.ts";
import type { ExtractionManifest, MoveWithRewriteOperation } from "../src/plan/manifest.ts";
import { buildPortfolio } from "../src/portfolio/rank.ts";
import type { RewriteEscape } from "../src/portfolio/types.ts";
import { byCodeUnit } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureGit, scratchDirectory, write } from "./support/fixture-repo.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "../fixtures/basic-monorepo");

const CHART = "apps/web/src/widgets/chart.ts";
const ZONE = "apps/web/src/Zone.ts";

/**
 * Dangling relative imports, in code-unit order. Case is the discriminator: a
 * collator folds it, so it puts `ledger.ts` before `Panel.ts` and
 * `absent-view.ts` before `Missing-panel.ts`, while `<` puts the capital first.
 * Both halves of the comparator are covered — the two `Panel.ts` rows differ
 * only in their specifier, so the tiebreak is what decides them.
 */
const UNRESOLVED: readonly (readonly [string, string])[] = [
  ["apps/web/src/Panel.ts", "./Missing-panel.ts"],
  ["apps/web/src/Panel.ts", "./absent-view.ts"],
  ["apps/web/src/ledger.ts", "./nowhere.ts"],
];

/**
 * The two escapes leaving `chart.ts`, in code-unit order, chosen for the same
 * reason: a collator sorts `ledger.ts` ahead of `Money.ts`.
 */
const CHART_ESCAPES: readonly (readonly [string, string])[] = [
  ["formatMoney", "../../../../libs/format/src/Money.ts"],
  ["formatLedger", "../../../../libs/format/src/ledger.ts"],
];

const CHART_SPECIFIERS = CHART_ESCAPES.map(([, specifier]) => specifier);

/** The escape leaving `Zone.ts`, which is the second file of the `file` half. */
const ZONE_SPECIFIER = "../../../libs/format/src/Money.ts";

/**
 * The control every case rests on: this machine's default collator must really
 * disagree with code-unit order on the data below. Without it a case could pass
 * on a machine where the two orders coincide while the defect was still there.
 * (Deliberately a copy of the identical helper in `test/plan-ordering.test.ts`;
 * a control is only worth having where it can be read beside the case it
 * guards.)
 */
function collationDisagrees(values: readonly string[]): boolean {
  const collated = [...values].toSorted((left, right) => left.localeCompare(right));
  const codeUnits = [...values].toSorted(byCodeUnit);
  return collated.some((value, index) => value !== codeUnits[index]);
}

function tuple(reference: UnresolvedReference): [string, string] {
  return [reference.source, reference.specifier];
}

/**
 * A copy of the fixture workspace carrying both shapes at once.
 *
 * `Panel.ts` and `ledger.ts` import files that do not exist, which is the only
 * way `graph.unresolved` gets entries at all. `chart.ts` reaches two modules of
 * `@acme/format` by relative path instead of by package name, and `Zone.ts`
 * reaches one — `libs/format` is a package root, so those are escapes the
 * planner can repair, and the two leaving `chart.ts` become a single `rewrites`
 * array. The package entrypoint re-exports both new modules because an escape is
 * only rewritable when the entrypoint already covers the bindings used.
 */
function workspaceWithEscapes(): string {
  const root = join(scratchDirectory(), "workspace");
  cpSync(FIXTURE, root, { recursive: true });
  rmSync(join(root, ".monocarve"), { recursive: true, force: true });

  write(
    root,
    "apps/web/src/Panel.ts",
    'import { missing } from "./Missing-panel.ts";\nimport { absent } from "./absent-view.ts";\n\nexport const panel = [missing, absent];\n',
  );
  write(root, "apps/web/src/ledger.ts", 'import { gone } from "./nowhere.ts";\n\nexport const ledger = gone;\n');

  write(root, "libs/format/src/Money.ts", "export function formatMoney(value: number): string {\n  return `$${value.toFixed(2)}`;\n}\n");
  write(root, "libs/format/src/ledger.ts", "export function formatLedger(value: number): string {\n  return value.toFixed(0);\n}\n");
  write(root, "libs/format/src/index.ts", 'export * from "./number.ts";\nexport * from "./Money.ts";\nexport * from "./ledger.ts";\n');

  write(
    root,
    ZONE,
    `import { formatMoney } from "${ZONE_SPECIFIER}";\n\nexport function zoneLabel(value: number): string {\n  return formatMoney(value);\n}\n`,
  );
  const chart = readFileSync(join(root, CHART), "utf8");
  write(
    root,
    CHART,
    `${CHART_ESCAPES.map(([binding, specifier]) => `import { ${binding} } from "${specifier}";`).join("\n")}\n` +
      `import { zoneLabel } from "../Zone.ts";\n${chart}\n` +
      "export const labels = [formatMoney(1), formatLedger(2), zoneLabel(3)];\n",
  );

  fixtureGit(root, "init", "-q", "-b", "work");
  fixtureGit(root, "config", "user.email", "fixture@example.invalid");
  fixtureGit(root, "config", "user.name", "Monocarve Fixture");
  fixtureGit(root, "config", "commit.gpgsign", "false");
  fixtureGit(root, "add", "-A");
  fixtureGit(root, "commit", "-qm", "test: seed workspace");
  return root;
}

interface Compiled {
  readonly graph: DependencyGraph;
  readonly manifest: ExtractionManifest;
  readonly rewriteEscapes: readonly RewriteEscape[];
}

let compiled: Promise<Compiled> | undefined;

/** Scan, rank, and compile once: the cruise is what costs, and both cases share it. */
function compile(): Promise<Compiled> {
  compiled ??= (async () => {
    const root = workspaceWithEscapes();
    const { config } = await loadConfig({ cwd: root });
    const graph = await scanDependencyGraph({ config, rootDir: root, noCache: true });
    const portfolio = buildPortfolio({ config, graph });

    // The chart closure itself, not the composition root that reaches it: the
    // smallest eligible candidate containing the moved module.
    const candidate = portfolio.candidates
      .filter((entry) => entry.eligible && entry.files.includes(CHART))
      .toSorted((left, right) => left.files.length - right.files.length)[0];
    expect(candidate).toBeDefined();

    const manifest = buildPlanSync({ config, rootDir: root, graph, candidate: candidate!, baselineCommit: graph.commit!, packageName: "@acme/chart" });
    return { graph, manifest, rewriteEscapes: candidate!.rewriteEscapes };
  })();
  return compiled;
}

afterAll(cleanupFixtures);

describe("graph.unresolved order", () => {
  test("decides manifest.graphDigest, and is by code unit", async () => {
    // Asserted before anything is compiled, so a failure here reads as "the test
    // data went stale" rather than "the engine regressed".
    expect(collationDisagrees(UNRESOLVED.map(([source]) => source))).toBe(true);
    const panelSpecifiers = UNRESOLVED.filter(([source]) => source.endsWith("Panel.ts")).map(([, spec]) => spec);
    expect(collationDisagrees(panelSpecifiers)).toBe(true);

    const { graph, manifest } = await compile();
    expect(graph.unresolved.map(tuple)).toEqual(UNRESOLVED.map(([source, specifier]) => [source, specifier]));

    const collated = [...graph.unresolved].toSorted((left, right) => left.source.localeCompare(right.source) || left.specifier.localeCompare(right.specifier));
    const codeUnits = [...graph.unresolved].toSorted((left, right) => byCodeUnit(left.source, right.source) || byCodeUnit(left.specifier, right.specifier));

    // The claim that makes the rest worth asserting: this array's order is not a
    // presentation detail, it is hashed, so the two orders are two different
    // plans for one commit. If that ever stopped being true, the assertion below
    // would keep passing while proving nothing.
    expect(graphDigest({ ...graph, unresolved: collated })).not.toBe(graphDigest({ ...graph, unresolved: codeUnits }));
    expect(manifest.graphDigest).toBe(graphDigest({ ...graph, unresolved: codeUnits }));
  });
});

describe("escape rewrite order", () => {
  test("decides the serialized rewrites of a move-with-rewrite, and is by code unit", async () => {
    expect(collationDisagrees(CHART_SPECIFIERS)).toBe(true);

    const { manifest } = await compile();
    // Read back out of the serialized bytes rather than off the object: that
    // array is what a reviewer and the replay proof both see, and
    // `serializeManifest` sorts object keys but never reorders an array.
    const serialized = JSON.parse(serializeManifest(manifest)) as ExtractionManifest;
    const operation = serialized.operations.find((entry): entry is MoveWithRewriteOperation => entry.kind === "move-with-rewrite" && entry.source === CHART);
    expect(operation).toBeDefined();
    expect(operation!.rewrites.map((rewrite) => rewrite.donorlessSpecifier)).toEqual(CHART_SPECIFIERS);
  });

  test("orders the whole escape list, file first, by code unit", async () => {
    // The `file` half cannot reach manifest bytes: operations are emitted by
    // iterating the plan's `sources`, so the journal holds `Zone.ts` before
    // `chart.ts` under either comparator. It is asserted here, at
    // `classifyEscapes`'s own boundary, because the comparator is one
    // expression — the half nothing observes still has to agree with the half
    // that is observed, and this is the only place that can say so.
    expect(collationDisagrees([ZONE, CHART])).toBe(true);

    const { rewriteEscapes } = await compile();
    expect(rewriteEscapes.map((escape) => [escape.file, escape.specifier])).toEqual([
      [ZONE, ZONE_SPECIFIER],
      [CHART, CHART_SPECIFIERS[0]!],
      [CHART, CHART_SPECIFIERS[1]!],
    ]);
  });
});

describe("workspace package order", () => {
  /**
   * Latent, and said plainly: nothing in `src/` calls `listPackages`, and the
   * map it looks like it feeds — `graph.workspace.packageNames` — is built
   * instead by `workspaceInventory`, from an owner list sorted with `Array#sort`
   * and therefore already in code-unit order. So this proves the adapter's
   * contract, not a plan difference anyone can observe today. It is here because
   * that contract is "packages come back in a deterministic order", and a
   * comparator that consults the machine's locale does not honour it.
   */
  test("pnpm lists workspace packages by code unit", async () => {
    const names = ["@acme/Money", "@acme/ledger"];
    expect(collationDisagrees(names)).toBe(true);

    const root = scratchDirectory();
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'libs/*'\n");
    for (const [dir, name] of [
      ["libs/Money", "@acme/Money"],
      ["libs/ledger", "@acme/ledger"],
    ] as const) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, "package.json"), `${JSON.stringify({ name, version: "0.0.0", private: true }, null, 2)}\n`);
    }

    expect((await pnpmAdapter.listPackages(root)).map((entry) => entry.name)).toEqual(names);
  });
});
