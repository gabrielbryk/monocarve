/**
 * Array order in the manifest is by code unit, never by locale.
 *
 * `serializeManifest` sorts object keys but never reorders an array, so the
 * order of every array the builder produces *is* the plan's bytes. Sorting one
 * of them with `localeCompare` makes those bytes a function of the machine's
 * ICU data and its default locale — neither of which is an input to a plan —
 * and the determinism invariant ("same repo + same commit + same config ⇒
 * byte-identical plan, `planId` included") quietly stops holding across
 * machines. Nothing in the suite would notice, because a plan compiled twice in
 * one process compares equal under either comparator.
 *
 * A failure looks like: a name list containing `Alpha` beside `alpha`, or a
 * path list containing `Module-ledger.json` beside `module-ledger.json`, comes
 * back in the order an `en-US` collator would put it in rather than the order
 * `<` puts it in. The fixture data below is chosen so those two orders actually
 * disagree — mixed case, a leading underscore, and a separator against no
 * separator — because on ordinary lowercase ASCII they agree and a test built
 * from such data proves nothing.
 *
 * `localeCompare`'s default-locale behaviour cannot be steered from inside a
 * bun test, so nothing here tries to. Instead every case asserts the exact
 * expected order and is paired with a control asserting that this machine's
 * collator really does disagree with it; if a future ICU ever made the two
 * agree, the control fails loudly rather than the case passing vacuously.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.ts";
import { scanDependencyGraph } from "../src/graph/cruiser.ts";
import { buildPlanSync } from "../src/plan/build.ts";
import { buildPortfolio } from "../src/portfolio/rank.ts";
import { byCodeUnit } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureGit, scratchDirectory, write } from "./support/fixture-repo.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "../fixtures/basic-monorepo");

const CHART = "apps/web/src/widgets/chart.ts";

/** Consumer filenames whose collated order is not their code-unit order. */
const CONSUMERS = ["Main-view.ts", "main-view.ts", "main.ts", "mainview.ts"].map((name) => `apps/web/src/${name}`);

/** Artifact paths whose collated order is not their code-unit order. */
const ARTIFACTS = ["generated/Module-ledger.json", "generated/module-ledger.json", "generated/modulesledger.json"];

/**
 * Exports added to the moved module, chosen for the same reason: a locale
 * collator folds case and demotes the leading `_`, so it interleaves these
 * differently from `<`.
 */
const ADDED_EXPORTS = ["Alpha", "_internal", "alpha", "ab", "a_b"];

/**
 * The control every case rests on: this machine's default collator must really
 * disagree with code-unit order on the data below. Without it a case could pass
 * on a machine where the two orders coincide while the defect was still there.
 */
function collationDisagrees(values: readonly string[]): boolean {
  const collated = [...values].sort((left, right) => left.localeCompare(right));
  const codeUnits = [...values].sort(byCodeUnit);
  return collated.some((value, index) => value !== codeUnits[index]);
}

/**
 * A copy of the fixture workspace, mutated so that three manifest arrays each
 * carry names the two orders disagree about: the moved module gains exports,
 * the application gains consumers, and the config declares extra generated
 * artifacts the same move triggers.
 */
function workspaceWithColliding(): string {
  const root = join(scratchDirectory(), "workspace");
  cpSync(FIXTURE, root, { recursive: true });
  rmSync(join(root, ".monocarve"), { recursive: true, force: true });

  const chart = readFileSync(join(root, CHART), "utf8");
  writeFileSync(
    join(root, CHART),
    `${chart}\n${ADDED_EXPORTS.map((name, index) => `export const ${name} = ${index};`).join("\n")}\n`,
  );

  // Every consumer reaches the closure, so every one of them lands in
  // `manifest.consumers` and the array is long enough for order to matter.
  for (const file of CONSUMERS) {
    if (file.endsWith("/main.ts")) continue;
    write(root, file, 'import { renderChart } from "./widgets/chart.ts";\n\nexport const view = renderChart;\n');
  }

  const configPath = join(root, "monocarve.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    generatedArtifacts: { artifacts: { path: string }[] };
  };
  config.generatedArtifacts.artifacts = ARTIFACTS.map((path) => ({
    path,
    source: "apps/web/src",
    regenerate: "sh scripts/module-ledger.sh",
    triggers: ["^apps/web/src/widgets/"],
  }));
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  fixtureGit(root, "init", "-q", "-b", "work");
  fixtureGit(root, "config", "user.email", "fixture@example.invalid");
  fixtureGit(root, "config", "user.name", "Monocarve Fixture");
  fixtureGit(root, "config", "commit.gpgsign", "false");
  fixtureGit(root, "add", "-A");
  fixtureGit(root, "commit", "-qm", "test: seed workspace");
  return root;
}

describe("code-unit ordering", () => {
  test("byCodeUnit orders by UTF-16 code unit, which is not the collated order", () => {
    const names = ["_internal", "Alpha", "alpha", "a_b", "ab", "Chart", "chart"];

    expect([...names].sort(byCodeUnit)).toEqual(["Alpha", "Chart", "_internal", "a_b", "ab", "alpha", "chart"]);
    // The control: `localeCompare` genuinely produces something else here, so
    // the assertion above is a claim about the comparator and not about a list
    // that would come out the same either way.
    expect(collationDisagrees(names)).toBe(true);
  });

  test("byCodeUnit agrees with the default Array#sort, which is the same ordering", () => {
    const names = ["_internal", "Alpha", "alpha", "a_b", "ab"];
    expect([...names].sort(byCodeUnit)).toEqual([...names].sort());
  });
});

describe("manifest array order", () => {
  afterAll(cleanupFixtures);

  test("is by code unit for exports, consumers, and generated files", async () => {
    // The three fixtures have to be discriminating or the plan-level assertions
    // below are decoration. Asserted before the plan is built so a failure here
    // reads as "the test data went stale", not "the builder regressed".
    expect(collationDisagrees(CONSUMERS)).toBe(true);
    expect(collationDisagrees(ARTIFACTS)).toBe(true);

    const root = workspaceWithColliding();
    const { config } = await loadConfig({ cwd: root });
    const graph = await scanDependencyGraph({ config, rootDir: root, noCache: true });
    const portfolio = buildPortfolio({ config, graph });

    // The chart closure itself, not one of the consumer components that reach
    // it: the smallest eligible candidate containing the moved module.
    const candidate = portfolio.candidates
      .filter((entry) => entry.eligible && entry.files.includes(CHART))
      .sort((left, right) => left.files.length - right.files.length)[0];
    expect(candidate).toBeDefined();

    const manifest = buildPlanSync({
      config,
      rootDir: root,
      graph,
      candidate: candidate!,
      baselineCommit: graph.commit!,
      packageName: "@acme/chart",
    });

    // `dedupeExports`. `Alpha` before `_internal` before `a_b` before `ab`
    // before `alpha` is code-unit order; a collator puts `_internal` first and
    // `Alpha` after `alpha`.
    const exportNames = manifest.target.requiredExports.map((entry) => entry.name);
    expect(exportNames).toEqual(["Alpha", "Point", "Series", "_internal", "a_b", "ab", "alpha", "renderChart"]);
    expect(collationDisagrees(exportNames)).toBe(true);

    // `findConsumers`. Uppercase `Main-view.ts` leads; a collator sorts it
    // between `main.ts` and `mainview.ts`.
    expect(manifest.consumers.map((entry) => entry.file)).toEqual(CONSUMERS);

    // `generatedFilesFor`.
    expect(manifest.generatedFiles.map((entry) => entry.path)).toEqual(ARTIFACTS);
  });
});
