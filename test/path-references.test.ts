/**
 * Paths that appear as strings rather than as imports.
 *
 * The failure this exists for: a test read a moved source file by path string
 * (`readFileSync("apps/web/src/widgets/chart.ts")`), which is an edge no import
 * graph contains, so the file was correctly absent from the plan and the test
 * still ENOENT'd the moment the move landed.
 *
 * Two halves, and the second is the load-bearing one. Detection is easy to make
 * look right and easy to make useless: a rule loose enough to catch every
 * spelling reports `dist/apps/web/src/widgets/chart.ts` as a reference to
 * `apps/web/src/widgets/chart.ts`, and a warning that fires on build output is
 * a warning people learn to skip. So every positive case here is paired with a
 * negative one that must stay silent, and the negatives share a tree with a
 * control that must fire — otherwise an index that always returned nothing
 * would pass them all.
 *
 * The limitation cases are assertions, not omissions. A concatenated path is
 * missed; that is pinned below with `toEqual([])` so nobody reads the passing
 * suite as a claim of completeness.
 */

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseConfig, type MonocarveUserConfig } from "../src/config.ts";
import { scanDependencyGraph } from "../src/graph/cruiser.ts";
import { WorkspaceContext } from "../src/plan/context.ts";
import { buildPathReferenceIndex } from "../src/plan/path-references.ts";
import { buildPortfolio } from "../src/portfolio/rank.ts";
import { cleanupFixtures, fixtureGit, scratchDirectory } from "./support/fixture-repo.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "../fixtures/basic-monorepo");

const CHART = "apps/web/src/widgets/chart.ts";

const roots: string[] = [];

function tree(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "monocarve-path-refs-")));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

function fixtureConfigFor(overrides: Partial<MonocarveUserConfig> = {}) {
  return parseConfig(
    {
      applications: [{ name: "web", sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json", packageName: "@acme/web", compositionRoots: [] }],
      packageRoots: ["libs"],
      packageScope: "@acme/",
      scaffoldTemplates: { entrypoint: "src/index.ts", packageJson: { contents: '{ "name": "{package}" }\n' } },
      ...overrides,
    },
    "<path-references fixture>",
  );
}

/** An index over a throwaway tree, with `pathReferences` overridden per case. */
function indexOver(files: Record<string, string>, overrides: Partial<MonocarveUserConfig> = {}) {
  const root = tree(files);
  const config = fixtureConfigFor(overrides);
  return buildPathReferenceIndex(new WorkspaceContext(config, root));
}

const CHART_SOURCE = "export const chart = 1;\n";

afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
  cleanupFixtures();
});

describe("path references: what is found", () => {
  test("a literal naming a moved path is found once, and its own import is not a second finding", () => {
    const index = indexOver({
      [CHART]: CHART_SOURCE,
      "apps/web/src/widgets/chart.test.ts": [
        'import { readFileSync } from "node:fs";',
        "",
        'import { chart } from "./chart.ts";',
        "",
        'export const source = readFileSync("apps/web/src/widgets/chart.ts", "utf8");',
        "export const used = chart;",
      ].join("\n"),
    });

    // Exactly one: the file imports the module *and* names its path, and only
    // the second is this scanner's business — the first is an import edge the
    // graph already carries and the codemod already rewrites.
    expect(index.referencesTo([CHART])).toEqual([
      { file: "apps/web/src/widgets/chart.test.ts", line: 5, column: 36, target: CHART, form: "path", text: CHART },
    ]);
  });

  test("a module specifier that spells the workspace path is not a finding", () => {
    const index = indexOver({
      [CHART]: CHART_SOURCE,
      // Every specifier position, in the one spelling that would collide: a
      // workspace-rooted specifier is textually identical to the path.
      "apps/web/src/importers.ts": [
        'import { chart } from "apps/web/src/widgets/chart.ts";',
        'export * from "apps/web/src/widgets/chart.ts";',
        'import type { X } from "apps/web/src/widgets/chart.ts";',
        'export type Y = import("apps/web/src/widgets/chart.ts").X;',
        'export const late = () => import("apps/web/src/widgets/chart.ts");',
        'export const old = require("apps/web/src/widgets/chart.ts");',
        "export const used = chart;",
      ].join("\n"),
      // The control: the same path, in a position that is not a specifier.
      "apps/web/src/reader.ts": ['import { readFileSync } from "node:fs";', 'export const raw = readFileSync("apps/web/src/widgets/chart.ts", "utf8");'].join(
        "\n",
      ),
    });

    expect(index.referencesTo([CHART]).map((reference) => reference.file)).toEqual(["apps/web/src/reader.ts"]);
  });

  test("an absolute literal carrying a machine prefix still names the path", () => {
    const index = indexOver({ [CHART]: CHART_SOURCE, "apps/web/src/reader.ts": 'export const p = "/opt/ci/checkout/apps/web/src/widgets/chart.ts";\n' });

    expect(index.referencesTo([CHART]).map((reference) => reference.text)).toEqual(["opt/ci/checkout/apps/web/src/widgets/chart.ts"]);
  });

  test("the extensionless spelling is found, and only when config asks for it", () => {
    const files = { [CHART]: CHART_SOURCE, "apps/web/src/registry.ts": 'export const modules = ["apps/web/src/widgets/chart"];\n' };

    const found = indexOver(files).referencesTo([CHART]);
    expect(found.map((reference) => [reference.file, reference.form])).toEqual([["apps/web/src/registry.ts", "stem"]]);

    expect(indexOver(files, { pathReferences: { matchExtensionless: false } }).referencesTo([CHART])).toEqual([]);
  });
});

describe("path references: the false-positive boundary", () => {
  test("a path that merely resembles a moved one is not a finding", () => {
    const index = indexOver({
      [CHART]: CHART_SOURCE,
      "apps/web/src/lookalikes.ts": [
        'import { readFileSync } from "node:fs";',
        "",
        "// apps/web/src/widgets/chart.ts is mentioned in this comment and does not stop resolving",
        'export const sibling = readFileSync("apps/web/src/widgets/chart.tsx");',
        'export const output = readFileSync("dist/apps/web/src/widgets/chart.ts");',
        'export const vendored = readFileSync("vendor/apps/web/src/widgets/chart.ts");',
        'export const namesake = readFileSync("apps/web/src/panels/chart.ts");',
        'export const stemmed = readFileSync("apps/web/src/widgets/chart.d.ts");',
        'export const relative = readFileSync("../widgets/chart.ts");',
        "",
        "// The control, so an index that found nothing at all could not pass this.",
        'export const real = readFileSync("apps/web/src/widgets/chart.ts");',
      ].join("\n"),
    });

    expect(index.referencesTo([CHART]).map((reference) => reference.line)).toEqual([12]);
  });

  test("minSegments is the boundary, and it comes from config", () => {
    const files = { "libs/logger/index.ts": "export const log = 1;\n", "apps/web/src/reader.ts": 'export const p = "libs/logger/index.ts";\n' };
    const target = "libs/logger/index.ts";

    expect(indexOver(files).referencesTo([target])).toHaveLength(1);
    // Three segments is the default; a workspace that wants a stricter rule
    // raises it and this literal stops being reported at all.
    expect(indexOver(files, { pathReferences: { minSegments: 4 } }).referencesTo([target])).toEqual([]);
  });

  test("the whole scan can be turned off", () => {
    const index = indexOver(
      { [CHART]: CHART_SOURCE, "apps/web/src/reader.ts": 'export const p = "apps/web/src/widgets/chart.ts";\n' },
      { pathReferences: { enabled: false } },
    );

    expect(index.filesScanned).toBe(0);
    expect(index.referencesTo([CHART])).toEqual([]);
  });
});

describe("path references: what it cannot see", () => {
  test("a computed or concatenated path is missed — pinned, not implied", () => {
    const index = indexOver({
      [CHART]: CHART_SOURCE,
      "apps/web/src/computed.ts": [
        'import { readFileSync } from "node:fs";',
        'import { join } from "node:path";',
        "",
        'const dir = "apps/web/src/widgets";',
        'const name = "chart";',
        "",
        "export const interpolated = readFileSync(`${dir}/chart.ts`);",
        'export const concatenated = readFileSync("apps/web/src/widgets/" + "chart.ts");',
        'export const joined = readFileSync(join("apps", "web", "src", "widgets", "chart.ts"));',
        "export const built = readFileSync(join(dir, `${name}.ts`));",
      ].join("\n"),
      // Control in the same tree: the scanner is working, it simply cannot
      // reconstruct any of the four spellings above.
      "apps/web/src/literal.ts": ['import { readFileSync } from "node:fs";', 'export const raw = readFileSync("apps/web/src/widgets/chart.ts");'].join("\n"),
    });

    const found = index.referencesTo([CHART]);
    expect(found.filter((reference) => reference.file === "apps/web/src/computed.ts")).toEqual([]);
    expect(found.map((reference) => reference.file)).toEqual(["apps/web/src/literal.ts"]);
  });

  test("a tree outside the source roots is missed until config names it", () => {
    const files = { [CHART]: CHART_SOURCE, "scripts/verify.sh": ["#!/bin/sh", "set -eu", "wc -l apps/web/src/widgets/chart.ts"].join("\n") };

    const byDefault = indexOver(files);
    expect(byDefault.referencesTo([CHART])).toEqual([]);
    expect(byDefault.filesScanned).toBe(1);

    const configured = indexOver(files, { pathReferences: { textRoots: [{ root: "scripts", extensions: [".sh"] }] } });
    expect(configured.filesScanned).toBe(2);
    expect(configured.referencesTo([CHART])).toEqual([{ file: "scripts/verify.sh", line: 3, column: 7, target: CHART, form: "path", text: CHART }]);
  });
});

/* -------------------------------------------------------------------------- */
/* The portfolio                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A copy of the fixture workspace, in its own git repository so the scanner can
 * resolve a baseline commit. The shipped fixture is never mutated: other suites
 * assert its exact module counts.
 */
function workspace(mutate: (root: string) => void): string {
  const root = join(scratchDirectory(), "workspace");
  cpSync(FIXTURE, root, { recursive: true });
  rmSync(join(root, ".monocarve"), { recursive: true, force: true });
  mutate(root);
  fixtureGit(root, "init", "-q", "-b", "work");
  fixtureGit(root, "config", "user.email", "fixture@example.invalid");
  fixtureGit(root, "config", "user.name", "Monocarve Fixture");
  fixtureGit(root, "config", "commit.gpgsign", "false");
  fixtureGit(root, "add", "-A");
  fixtureGit(root, "commit", "-qm", "test: seed workspace");
  return root;
}

function readConfig(root: string) {
  return JSON.parse(fs.readFileSync(join(root, "monocarve.config.json"), "utf8")) as Record<string, unknown>;
}

function writeConfig(root: string, config: Record<string, unknown>): void {
  writeFileSync(join(root, "monocarve.config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

describe("portfolio warnings", () => {
  test("a candidate whose files are named by a string literal warns, and stays eligible", async () => {
    const root = workspace((created) => {
      const test = join(created, "apps/web/src/widgets/chart.test.ts");
      writeFileSync(
        test,
        `${fs.readFileSync(test, "utf8")}\n` +
          'import { readFileSync } from "node:fs";\n\n' +
          'export const source = readFileSync("apps/web/src/widgets/chart.ts", "utf8");\n',
      );
    });
    const config = parseConfig(readConfig(root), "<fixture>");
    const graph = await scanDependencyGraph({ config, rootDir: root, noCache: true });
    const portfolio = buildPortfolio({ config, graph });

    const candidate = portfolio.candidates.find((entry) => entry.files.includes(CHART));
    expect(candidate).toBeDefined();
    const warning = candidate!.warnings.find((entry) => entry.includes("string literal"));
    expect(warning).toBeDefined();
    expect(warning).toContain("apps/web/src/widgets/chart.test.ts:12");
    expect(warning).toContain(CHART);
    // Non-blocking, and that is the point: the heuristic may be wrong, and a
    // wrong heuristic must not make a correct extraction unplannable.
    expect(candidate!.eligible).toBe(true);
    expect(candidate!.rejectionReasons).toEqual([]);

    // Control: candidates whose files nothing names by string carry no such
    // warning, so the message is a fact about this closure and not a banner.
    const others = portfolio.candidates.filter((entry) => !entry.files.includes(CHART));
    expect(others.length).toBeGreaterThan(0);
    expect(others.flatMap((entry) => entry.warnings.filter((line) => line.includes("string literal")))).toEqual([]);
  }, 120_000);

  test("the repository is scanned once for the whole portfolio, not once per candidate", async () => {
    // Twelve files nothing else in the pipeline reads: they are not source, not
    // config, and not in any package. Every read of one is a read this scan
    // performed, which makes the count unambiguous.
    const corpus = 12;
    const root = workspace((created) => {
      for (let index = 0; index < corpus; index += 1) {
        const path = join(created, `scripts/gate-${index}.sh`);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `#!/bin/sh\nwc -l apps/web/src/widgets/chart.ts # gate ${index}\n`);
      }
      const config = readConfig(created);
      config["pathReferences"] = { textRoots: [{ root: "scripts", extensions: [".sh"] }] };
      writeConfig(created, config);
    });
    const config = parseConfig(readConfig(root), "<fixture>");
    const graph = await scanDependencyGraph({ config, rootDir: root, noCache: true });

    const reads = spyOn(fs, "readFileSync");
    let portfolio;
    let scriptReads: string[];
    try {
      portfolio = buildPortfolio({ config, graph });
      // Read before restoring: `mockRestore` resets the call list.
      scriptReads = reads.mock.calls.map((call) => String(call[0])).filter((path) => path.includes("/scripts/gate-") && path.endsWith(".sh"));
    } finally {
      reads.mockRestore();
    }

    // More than one candidate, so "once per candidate" and "once" are different
    // numbers; without this the assertion below would prove nothing.
    expect(portfolio.candidates.length).toBeGreaterThan(2);
    expect(scriptReads).toHaveLength(corpus);
    expect(new Set(scriptReads).size).toBe(corpus);
  }, 120_000);
});
