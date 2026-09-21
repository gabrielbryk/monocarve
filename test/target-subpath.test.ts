/**
 * `--target-subpath`: where moved files land inside an existing package.
 *
 * The default preserves the path a file had below its application source root,
 * which is right for a new package mirroring the application and wrong for an
 * existing package with a flatter layout — extending a flat `src/` with
 * `<app>/build/detect.ts` would otherwise create a `src/build/` directory the
 * package does not use. The override has to move the *whole* derivation, not
 * just the move target: the generated barrel, the recorded plan target and the
 * refresh comparison all read the same value, so the negatives here check that
 * the package it produces is coherent rather than merely differently named.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { buildDependencyGraph, type ScanReport } from "../src/graph/build.ts";
import { buildPlanSync } from "../src/plan/build.ts";
import { refreshExtractionPlan } from "../src/plan/refresh.ts";
import { validatePlan } from "../src/plan/validate.ts";
import { normalizeTargetSubpath, packageModulePath } from "../src/plan/target-layout.ts";
import { buildPortfolio } from "../src/portfolio/rank.ts";
import type { PortfolioCandidate } from "../src/portfolio/types.ts";
import { resolveCommit } from "../src/util/git.ts";
import { cleanupFixtures, fixtureConfig, fixtureRepo } from "./support/fixture-repo.ts";

const DONOR = "apps/api/src/build/detect.ts";
const CONSUMER = "apps/api/src/server.ts";
const PACKAGE = "@acme/target";
const PACKAGE_ROOT = "libs/target";

const LOCKFILE = ["lockfileVersion: '9.0'", "", "importers:", "", "  .: {}", "", "  apps/api: {}", "", "  libs/target: {}", ""].join("\n");

function workspace(extra: Record<string, string> = {}) {
  const root = fixtureRepo({
    "package.json": `${JSON.stringify({ name: "fixture-workspace", private: true, type: "module" }, null, 2)}\n`,
    "pnpm-lock.yaml": LOCKFILE,
    "apps/api/tsconfig.json": `${JSON.stringify({ include: ["src"] }, null, 2)}\n`,
    "apps/api/package.json": '{"name":"@acme/api","private":true}\n',
    [DONOR]: "export const detect = () => 1;\n",
    [CONSUMER]: 'import { detect } from "./build/detect.ts";\n\nexport const used = detect();\n',
    [`${PACKAGE_ROOT}/package.json`]: '{"name":"@acme/target","private":true,"type":"module","main":"./src/index.ts","types":"./src/index.ts"}\n',
    [`${PACKAGE_ROOT}/src/existing.ts`]: "export const existing = 1;\n",
    ...extra,
  });
  const config = fixtureConfig(root);
  return { root, config, ...graphFor(root, config, Object.keys(extra).filter((path) => path.startsWith("apps/"))) };
}

function graphFor(root: string, config: ReturnType<typeof fixtureConfig>, extraSources: readonly string[]) {
  const modules: ScanReport["modules"] = [
    { source: DONOR, dependencies: [] },
    ...extraSources.map((source) => ({ source, dependencies: [] })),
    { source: CONSUMER, dependencies: [{ module: "./build/detect.ts", resolved: DONOR }, ...extraSources.map((source) => ({ module: `./${source.slice("apps/api/src/".length)}`, resolved: source }))] },
  ];
  const graph = buildDependencyGraph({ config, rootDir: root, reports: { api: { modules } }, commit: resolveCommit(root, "HEAD").commit });
  const candidate = buildPortfolio({ config, graph }).candidates.find((entry) => entry.files.includes(DONOR));
  if (candidate === undefined) throw new Error("fixture candidate missing");
  return { graph, candidate: candidate as PortfolioCandidate };
}

function moveTargets(manifest: ReturnType<typeof buildPlanSync>): string[] {
  return manifest.operations.flatMap((operation) => operation.kind === "move" || operation.kind === "move-with-rewrite" ? [operation.target] : []);
}

describe("target subpath — path derivation", () => {
  test("normalizes an accepted subpath and refuses everything that escapes the package source directory", () => {
    expect(normalizeTargetSubpath("./src/lib/")).toBe("src/lib");
    expect(normalizeTargetSubpath("src")).toBe("src");
    expect(() => normalizeTargetSubpath("")).toThrow("non-empty package-relative directory");
    expect(() => normalizeTargetSubpath("/src")).toThrow("empty");
    expect(() => normalizeTargetSubpath("src/../../elsewhere")).toThrow('".." segments');
    expect(() => normalizeTargetSubpath("lib")).toThrow("must be src or a directory below it");
  });

  test("a subpath lands files by basename; the default preserves application structure", () => {
    const context = { targetRelativePath: (source: string) => source.slice("apps/api/src/".length) };
    expect(packageModulePath(context, DONOR, undefined)).toBe("build/detect.ts");
    expect(packageModulePath(context, DONOR, "src")).toBe("detect.ts");
    expect(packageModulePath(context, DONOR, "src/build-tools")).toBe("build-tools/detect.ts");
  });
});

describe("target subpath — compiled plans", () => {
  afterEach(cleanupFixtures);

  test("without it, the donor keeps its application-relative path inside the package", () => {
    const { root, config, graph, candidate } = workspace();
    const manifest = buildPlanSync({ config, rootDir: root, graph, candidate, baselineCommit: "HEAD", packageName: PACKAGE });

    expect(moveTargets(manifest)).toEqual([`${PACKAGE_ROOT}/src/build/detect.ts`]);
    expect(manifest.target.targetSubpath).toBeUndefined();
  }, 60_000);

  test("with it, the donor lands directly in the requested directory and the barrel agrees", () => {
    const { root, config, graph, candidate } = workspace();
    const manifest = buildPlanSync({
      config, rootDir: root, graph, candidate, baselineCommit: "HEAD", packageName: PACKAGE, targetSubpath: "./src/",
    });

    expect(moveTargets(manifest)).toEqual([`${PACKAGE_ROOT}/src/detect.ts`]);
    // Normalized once, recorded once: the reviewed manifest carries the exact
    // directory, not the string the caller happened to type.
    expect(manifest.target.targetSubpath).toBe("src");
    const barrel = manifest.operations.find((operation) => operation.kind === "write-file" && operation.path === `${PACKAGE_ROOT}/src/index.ts`);
    // A barrel still naming ./build/detect.ts would point at nothing: the
    // package would be unbuildable while every byte proof passed.
    expect(barrel?.kind === "write-file" ? barrel.contents : "").toContain("./detect.ts");
    expect(barrel?.kind === "write-file" ? barrel.contents : "").not.toContain("build/detect.ts");
    expect(validatePlan(manifest, { config, rootDir: root }).issues.filter((issue) => issue.severity === "error")).toEqual([]);
  }, 60_000);

  test("it applies only to an existing package", () => {
    const { root, config, graph, candidate } = workspace();
    expect(() => buildPlanSync({
      config, rootDir: root, graph, candidate, baselineCommit: "HEAD", packageName: "@acme/fresh", targetSubpath: "src",
    })).toThrow("applies only when extending an existing package");
  }, 60_000);

  test("two selected files whose basenames collide are refused, not silently merged", () => {
    const second = "apps/api/src/probe/detect.ts";
    const { root, config, graph, candidate } = workspace({ [second]: "export const other = 2;\n" });
    const both = { ...candidate, files: [DONOR, second].sort() };

    expect(() => buildPlanSync({
      config, rootDir: root, graph, candidate: both, baselineCommit: "HEAD", packageName: PACKAGE, targetSubpath: "src",
    })).toThrow("would land on the same target path");
  }, 60_000);

  test("a refresh keeps the reviewed subpath instead of relocating the extraction", () => {
    const { root, config, graph, candidate } = workspace();
    const manifest = buildPlanSync({
      config, rootDir: root, graph, candidate, baselineCommit: "HEAD", packageName: PACKAGE, targetSubpath: "src",
    });

    const refreshed = refreshExtractionPlan({ manifest, config, rootDir: root, graph, resolveCandidate: () => candidate });

    expect(refreshed.manifest.target.targetSubpath).toBe("src");
    expect(moveTargets(refreshed.manifest)).toEqual([`${PACKAGE_ROOT}/src/detect.ts`]);
    expect(refreshed.semanticDiff).toEqual([]);
  }, 60_000);
});
