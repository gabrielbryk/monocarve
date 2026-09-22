/**
 * The evaluation closure: which modules importing the extracted package runs.
 *
 * Every case here is about a boundary the per-file detector cannot see. The
 * detector answers "what does this file's top level do"; these answer "which
 * files does the barrel evaluate", and the interesting answers are all outside
 * the moved set.
 *
 * Two habits run through the file, both deliberate:
 *
 *  - **Every exclusion carries its own control.** "A `type-only` edge does not
 *    pull its target in" is a claim that passes trivially if the target was
 *    never reachable at all, so each exclusion test first asserts that the
 *    target *is* present in the kind-erased adjacency the graph exposes
 *    (`graph.outgoing`) — the exact structure a plausible implementation would
 *    have traversed. Without the control the test proves nothing; with it, the
 *    test fails against an implementation that follows `outgoing`.
 *  - **The sources are real.** Edge kinds are recovered from the AST, by both
 *    the graph builder and the traversal, so a fixture that only *claimed* an
 *    import was type-only in a synthetic scanner report would be testing the
 *    report rather than the code.
 */

import { afterAll, describe, expect, test } from "bun:test";

import { resetCodemodCaches } from "../src/codemod/imports.ts";
import type { MonocarveConfig } from "../src/config.ts";
import { buildDependencyGraph, type ScanReport } from "../src/graph/build.ts";
import { resetGraphCaches } from "../src/graph/cruiser.ts";
import { WorkspaceContext } from "../src/plan/context.ts";
import { evaluationClosure, type EvaluationClosure } from "../src/plan/evaluation-closure.ts";
import { buildPortfolio } from "../src/portfolio/rank.ts";
import { cleanupFixtures, fixtureConfig, fixtureRepo } from "./support/fixture-repo.ts";

const APP = "apps/api/src";

/** A package manifest whose entry file is its own `src/index.ts`. */
function libManifest(name: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ name, version: "0.0.0", private: true, type: "module", main: "./src/index.ts", types: "./src/index.ts", ...extra }, null, 2)}\n`;
}

const TSCONFIG = `${JSON.stringify({ compilerOptions: { moduleResolution: "Bundler", strict: true, noEmit: true } }, null, 2)}\n`;

/**
 * The workspace every case here is carved out of.
 *
 * One application, four workspace packages, and four third-party packages
 * installed with four different `sideEffects` postures. Each seed module below
 * exercises exactly one edge kind, so a case can name its seed and say nothing
 * else about the tree.
 */
function workspaceFiles(): Record<string, string> {
  return {
    "package.json": `${JSON.stringify({ name: "root", private: true }, null, 2)}\n`,
    "apps/api/package.json": `${JSON.stringify({ name: "@acme/api", private: true, type: "module" }, null, 2)}\n`,
    "apps/api/tsconfig.json": TSCONFIG,

    // Clean top level. Everything it causes to run, it causes through imports.
    [`${APP}/widget/widget.ts`]: [
      'import { format } from "@acme/effects";',
      "",
      "export function widget(value: number): string {",
      "  return format(value);",
      "}",
      "",
    ].join("\n"),

    // Reaches the same package as `widget.ts`, so the shared modules must be
    // recorded once and not twice.
    [`${APP}/widget/sibling.ts`]: ['import { format } from "@acme/effects";', "", "export const sibling = (value: number): string => format(value);", ""].join(
      "\n",
    ),

    // Type-only: erased before anything runs.
    [`${APP}/typed/typed.ts`]: [
      'import type { Shape } from "@acme/typed";',
      "",
      "export function area(shape: Shape): number {",
      "  return shape.size;",
      "}",
      "",
    ].join("\n"),

    // Dynamic: lazy by construction.
    [`${APP}/lazy/lazy.ts`]: [
      "export async function load(): Promise<number> {",
      '  const module = await import("@acme/lazy");',
      "  return module.lazyValue;",
      "}",
      "",
    ].join("\n"),

    // A two-module cycle, both moved, both reaching the same package.
    [`${APP}/cycle/one.ts`]: [
      'import { format } from "@acme/effects";',
      'import { two } from "./two.ts";',
      "",
      "export const one = (value: number): string => `${format(value)}${two(value)}`;",
      "",
    ].join("\n"),
    [`${APP}/cycle/two.ts`]: [
      'import { one } from "./one.ts";',
      "",
      'export const two = (value: number): string => (value > 0 ? one(value - 1) : "");',
      "",
    ].join("\n"),

    // Reaches four third-party packages and nothing first-party.
    [`${APP}/vendor/vendor.ts`]: [
      'import { clean } from "clean-pkg";',
      'import { quiet } from "quiet-pkg";',
      'import { loud } from "loud-pkg";',
      'import { ghost } from "ghost-pkg";',
      'import { readFileSync } from "node:fs";',
      "",
      "export const vendor = [clean, quiet, loud, ghost, readFileSync].length;",
      "",
    ].join("\n"),

    // The escape case: a relative import of application code that a
    // `move-with-rewrite` will repoint at a workspace package.
    [`${APP}/escape/escape.ts`]: [
      'import { appLogger } from "../shared/logger.ts";',
      "",
      "export const escape = (message: string): void => appLogger(message);",
      "",
    ].join("\n"),
    [`${APP}/shared/logger.ts`]: [
      "export const appLogger = (message: string): void => {",
      "  globalThis.console.log(message);",
      "};",
      "",
      "appLogger('app logger installed');",
      "",
    ].join("\n"),

    // A closure with nothing in it: declarations only, no imports.
    [`${APP}/inert/inert.ts`]: ["export interface Point {", "  x: number;", "}", "", "export type Pair = [Point, Point];", ""].join("\n"),

    /* -- workspace packages ------------------------------------------------ */

    "libs/effects/package.json": libManifest("@acme/effects"),
    "libs/effects/src/index.ts": 'export * from "./register.ts";\n',
    // The module the whole exercise is about: nothing moves it, nothing in the
    // application names it, and its top level runs the moment the barrel is
    // imported.
    "libs/effects/src/register.ts": [
      "export const registry = new Map<string, number>();",
      "",
      "registry.set('installed', 1);",
      "",
      "export function format(value: number): string {",
      "  return value.toFixed(2);",
      "}",
      "",
    ].join("\n"),

    "libs/typed/package.json": libManifest("@acme/typed"),
    "libs/typed/src/index.ts": [
      "export interface Shape {",
      "  size: number;",
      "}",
      "",
      "export const shapes: string[] = [];",
      "",
      "shapes.push('registered at evaluation');",
      "",
    ].join("\n"),

    "libs/lazy/package.json": libManifest("@acme/lazy"),
    "libs/lazy/src/index.ts": ["export const lazyValue = 1;", "", "globalThis.console.log('lazy package evaluated');", ""].join("\n"),

    // Declares an entry file that is not on disk, so the traversal can name the
    // boundary it failed to cross instead of silently reporting a clean closure.
    "libs/missing/package.json": libManifest("@acme/missing", { main: "./src/nowhere.ts", types: "./src/nowhere.ts" }),
    "libs/missing/src/placeholder.ts": "export const placeholder = 1;\n",

    /* -- installed third-party packages ------------------------------------ */

    "node_modules/clean-pkg/package.json": `${JSON.stringify({ name: "clean-pkg", version: "1.0.0", sideEffects: false }, null, 2)}\n`,
    "node_modules/quiet-pkg/package.json": `${JSON.stringify({ name: "quiet-pkg", version: "1.0.0" }, null, 2)}\n`,
    "node_modules/loud-pkg/package.json": `${JSON.stringify({ name: "loud-pkg", version: "1.0.0", sideEffects: true }, null, 2)}\n`,
  };
}

interface Fixture {
  readonly root: string;
  readonly config: MonocarveConfig;
  readonly context: WorkspaceContext;
  readonly graph: ReturnType<typeof buildDependencyGraph>;
  closureOf(seeds: readonly string[], rewrites?: Map<string, { donorlessSpecifier: string; packageSpecifier: string }[]>): EvaluationClosure;
}

/**
 * A scanner report over the application, with relative imports resolved the way
 * a real cruise resolves them and bare specifiers left unresolved — which is the
 * shape a workspace without `node_modules` symlinks for its own packages
 * produces, and the one that makes the graph alone insufficient.
 */
function applicationReport(): ScanReport {
  return {
    modules: [
      { source: `${APP}/widget/widget.ts`, dependencies: [{ module: "@acme/effects", couldNotResolve: true }] },
      { source: `${APP}/widget/sibling.ts`, dependencies: [{ module: "@acme/effects", couldNotResolve: true }] },
      { source: `${APP}/typed/typed.ts`, dependencies: [{ module: "@acme/typed", couldNotResolve: true }] },
      { source: `${APP}/lazy/lazy.ts`, dependencies: [{ module: "@acme/lazy", dynamic: true, couldNotResolve: true }] },
      {
        source: `${APP}/cycle/one.ts`,
        dependencies: [
          { module: "@acme/effects", couldNotResolve: true },
          { module: "./two.ts", resolved: `${APP}/cycle/two.ts` },
        ],
      },
      { source: `${APP}/cycle/two.ts`, dependencies: [{ module: "./one.ts", resolved: `${APP}/cycle/one.ts` }] },
      { source: `${APP}/vendor/vendor.ts`, dependencies: [] },
      { source: `${APP}/escape/escape.ts`, dependencies: [{ module: "../shared/logger.ts", resolved: `${APP}/shared/logger.ts` }] },
      { source: `${APP}/shared/logger.ts`, dependencies: [] },
      { source: `${APP}/inert/inert.ts`, dependencies: [] },
    ],
  };
}

function fixture(files: Record<string, string> = workspaceFiles()): Fixture {
  // The caches key on paths, and every fixture is a fresh temporary tree at the
  // same relative paths as the last one.
  resetGraphCaches();
  resetCodemodCaches();
  const root = fixtureRepo(files);
  const config = fixtureConfig(root);
  const context = new WorkspaceContext(config, root);
  const graph = buildDependencyGraph({ config, rootDir: root, reports: { api: applicationReport() } });
  return {
    root,
    config,
    context,
    graph,
    closureOf: (seeds, rewrites) => evaluationClosure({ config, context, graph, seeds, ...(rewrites ? { rewrites } : {}) }),
  };
}

describe("evaluation closure", () => {
  afterAll(cleanupFixtures);

  test("follows a bare workspace import into the package's own modules", () => {
    const { context, graph, closureOf } = fixture();
    const closure = closureOf([`${APP}/widget/widget.ts`]);

    // The control that makes this test mean something: the reached module is
    // not in the graph at all. The application was cruised, the bare specifier
    // did not resolve to a file, and so no amount of edge-following inside
    // `graph` could ever have produced this answer — it is the package-name hop
    // through the workspace inventory that does.
    expect(graph.paths).not.toContain("libs/effects/src/register.ts");
    expect(graph.workspaceDependenciesBySource.get(`${APP}/widget/widget.ts`)).toEqual(new Set(["libs/effects"]));

    expect(closure.seeds).toEqual([`${APP}/widget/widget.ts`]);
    expect(closure.reached).toEqual(["libs/effects/src/index.ts", "libs/effects/src/register.ts"]);
    // And the seed's own top level really is clean, so the moved-set-only
    // inventory this replaces would have reported nothing whatsoever.
    expect(context.evaluationEffectKinds(`${APP}/widget/widget.ts`)).toEqual([]);
    expect(context.evaluationEffectKinds("libs/effects/src/register.ts")).toEqual(["expression-statement", "initializer-call"]);
  });

  test("does not follow a type-only edge", () => {
    const { context, graph, closureOf } = fixture();

    // The control: the target is effectful, and the graph's own kind-erased
    // adjacency lists it. An implementation that walked `graph.outgoing`, or
    // that read `workspaceDependenciesBySource` without asking how the specifier
    // was written, pulls it in and fails here.
    expect(context.evaluationEffectKinds("libs/typed/src/index.ts")).toEqual(["expression-statement"]);
    expect(graph.workspaceDependenciesBySource.get(`${APP}/typed/typed.ts`)).toEqual(new Set(["libs/typed"]));

    const closure = closureOf([`${APP}/typed/typed.ts`]);
    expect(closure.reached).toEqual([]);
    expect(closure.modules).toEqual([`${APP}/typed/typed.ts`]);
  });

  test("does not follow a dynamic edge", () => {
    const { context, graph, closureOf } = fixture();

    // Same control. `expectedDynamicImportDelta` is what tracks this specifier;
    // counting it here as well would report one risk twice, under a name that
    // says the code runs eagerly when it does not.
    expect(context.evaluationEffectKinds("libs/lazy/src/index.ts")).toEqual(["expression-statement"]);
    expect(graph.workspaceDependenciesBySource.get(`${APP}/lazy/lazy.ts`)).toEqual(new Set(["libs/lazy"]));

    const closure = closureOf([`${APP}/lazy/lazy.ts`]);
    expect(closure.reached).toEqual([]);
  });

  test("records third-party packages with their own sideEffects claim, absent kept apart from false", () => {
    const { closureOf } = fixture();
    const closure = closureOf([`${APP}/vendor/vendor.ts`]);

    expect(closure.packages).toEqual([
      // Installed and declares `false`.
      { name: "clean-pkg", sideEffects: "none" },
      // Not installed: nothing was read, and that is not the same as "false".
      { name: "ghost-pkg", sideEffects: "unresolved" },
      // Installed and declares `true`.
      { name: "loud-pkg", sideEffects: "some" },
      // Installed and says nothing. The distinction from `clean-pkg` is the
      // whole point: collapsing the two would turn "we do not know" into "the
      // package promised it was fine".
      { name: "quiet-pkg", sideEffects: "undeclared" },
    ]);
    // Builtins are not packages the extraction could reach into, and recording
    // `node:fs` as an unresolved third-party dependency would be noise.
    expect(closure.packages.map((entry) => entry.name)).not.toContain("node:fs");
    expect(closure.reached).toEqual([]);
  });

  test("terminates on a cycle and records a module reached twice exactly once", () => {
    const { closureOf } = fixture();
    const closure = closureOf([`${APP}/cycle/one.ts`, `${APP}/cycle/two.ts`, `${APP}/widget/widget.ts`, `${APP}/widget/sibling.ts`]);

    // `one` and `two` import each other; three of the four seeds import
    // `@acme/effects`. Reaching the package's two modules once each is the
    // claim — a traversal without a visited set does not return at all, and one
    // that deduped only at the end would still walk the cycle forever.
    expect(closure.reached).toEqual(["libs/effects/src/index.ts", "libs/effects/src/register.ts"]);
    expect(closure.modules).toHaveLength(6);
    expect(new Set(closure.modules).size).toBe(closure.modules.length);
  });

  test("follows the rewritten specifier, not the one the donor file still holds", () => {
    const { closureOf } = fixture();
    const seeds = [`${APP}/escape/escape.ts`];

    // Without the rewrite the closure describes the baseline: the escape points
    // at application code, and that is what evaluates.
    expect(closureOf(seeds).reached).toEqual([`${APP}/shared/logger.ts`]);

    // With it, the plan is about to repoint that specifier at a package, so the
    // module that will actually run is the package's — and the application file
    // it used to name stays behind, unmoved and no longer imported.
    const rewritten = closureOf(
      seeds,
      new Map([[`${APP}/escape/escape.ts`, [{ donorlessSpecifier: "../shared/logger.ts", packageSpecifier: "@acme/effects" }]]]),
    );
    expect(rewritten.reached).toEqual(["libs/effects/src/index.ts", "libs/effects/src/register.ts"]);
    expect(rewritten.reached).not.toContain(`${APP}/shared/logger.ts`);
  });

  test("names a workspace package it could not follow instead of reporting a clean closure", () => {
    const files = workspaceFiles();
    files[`${APP}/opaque/opaque.ts`] = 'import { thing } from "@acme/missing";\n\nexport const opaque = thing;\n';
    const { closureOf } = fixture(files);

    const closure = closureOf([`${APP}/opaque/opaque.ts`]);
    // `@acme/missing` is a workspace package whose manifest points at a file
    // that is not there. Silence here would read as "the closure ends", which
    // is the one thing that is certainly false.
    expect(closure.opaqueSpecifiers).toEqual(["@acme/missing"]);
    expect(closure.reached).toEqual([]);
    expect(closure.packages).toEqual([]);
  });

  test("is byte-identical across two independent traversals of the same tree", () => {
    const first = fixture();
    const seeds = [`${APP}/widget/widget.ts`, `${APP}/vendor/vendor.ts`, `${APP}/cycle/one.ts`];
    const once = first.closureOf(seeds);

    // A second context over the same tree, with every cache cold: the traversal
    // walks a `Set`, reads a `Map` of package owners and probes `node_modules`
    // per owner, and each of those is a place a discovery-ordered iteration
    // would leak into the manifest's bytes.
    const second = new WorkspaceContext(first.config, first.root);
    const twice = evaluationClosure({ config: first.config, context: second, graph: first.graph, seeds: [...seeds].reverse() });

    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    expect(once.reached).toEqual([...once.reached].sort());
    expect(once.packages.map((entry) => entry.name)).toEqual([...once.packages.map((entry) => entry.name)].sort());
  });

  test("draws no evaluation warning when the whole closure is inert", () => {
    // The zero case for the portfolio warning. `inert.ts` declares two types and
    // imports nothing, so widening the question from the moved set to the
    // closure adds nothing to widen it with — and a warning that fired anyway
    // would make every other warning in the report unreadable.
    const { config, context, graph } = fixture();
    const portfolio = buildPortfolio({ config, graph, context });
    const inert = portfolio.candidates.find((entry) => entry.files.join() === `${APP}/inert/inert.ts`);

    expect(inert).toBeDefined();
    expect(inert!.warnings.filter((warning) => warning.includes("do work when evaluated"))).toEqual([]);
    expect(inert!.warnings.filter((warning) => warning.includes("third-party package"))).toEqual([]);

    // The contrast, from the same portfolio, so the absence above is a property
    // of the candidate and not of the run.
    const widget = portfolio.candidates.find((entry) => entry.files.join() === `${APP}/widget/widget.ts`);
    expect(widget).toBeDefined();
    expect(widget!.warnings.filter((warning) => warning.includes("do work when evaluated"))).toHaveLength(1);
  });

  test("caps and ranks the third-party warning instead of listing everything", () => {
    const files = workspaceFiles();
    const names = ["a-pkg", "b-pkg", "c-pkg", "d-pkg", "e-pkg"];
    for (const name of names) {
      files[`node_modules/${name}/package.json`] = `${JSON.stringify({ name, version: "1.0.0", sideEffects: false }, null, 2)}\n`;
    }
    files[`${APP}/vendor/vendor.ts`] = [
      ...names.map((name) => `import { value as ${name.replace("-", "_")} } from "${name}";`),
      'import { loud } from "loud-pkg";',
      "",
      `export const vendor = [${names.map((name) => name.replace("-", "_")).join(", ")}, loud].length;`,
      "",
    ].join("\n");

    const { config, context, graph } = fixture(files);
    const portfolio = buildPortfolio({ config, graph, context });
    const vendor = portfolio.candidates.find((entry) => entry.files.join() === `${APP}/vendor/vendor.ts`);
    const warning = vendor!.warnings.find((entry) => entry.includes("third-party package"));

    expect(warning).toBeDefined();
    // Six packages reached, three named, and the one that admits to having
    // effects is named first — an alphabetical cap would have shown `a-pkg`,
    // `b-pkg`, `c-pkg` and buried the only entry worth opening.
    expect(warning).toContain("reaches 6 third-party package(s)");
    expect(warning).toContain("loud-pkg (declares some)");
    expect(warning!.indexOf("loud-pkg")).toBeLessThan(warning!.indexOf("a-pkg"));
    expect(warning).toContain("+3 more");
    expect(warning).not.toContain("e-pkg");
  });
});
