import { describe, expect, test } from "bun:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIG_FILENAMES, TOOL_NAME } from "../src/branding.ts";
import { applicationFor, findConfigFile, firstPartyRoots, getApplication, isAssetPath, isGuardedBranch, isTestPath, loadConfig, movableRoots, packageNameMatcher, parseConfig, scaffoldFor, scopedPackageName } from "../src/config.ts";
import { ConfigError } from "../src/errors.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "../fixtures/basic-monorepo");

describe("config loading", () => {
  test("discovers the config by walking up from a nested source file", () => {
    expect(findConfigFile(join(FIXTURE, "apps/web/src/widgets"))).toBe(join(FIXTURE, `${TOOL_NAME}.config.json`));
    expect(CONFIG_FILENAMES).toContain(`${TOOL_NAME}.config.json`);
  });

  test("loads the fixture config and applies defaults", async () => {
    const { config, configPath, rootDir } = await loadConfig({ cwd: join(FIXTURE, "apps/api/src") });

    expect(configPath).toBe(join(FIXTURE, `${TOOL_NAME}.config.json`));
    expect(rootDir).toBe(FIXTURE);
    expect(config.applications.map((app) => app.name)).toEqual(["web", "api"]);
    expect(config.packageRoots).toEqual(["libs"]);
    expect(config.packageScope).toBe("@acme/");

    // The fixture declares its own source-classification conventions.
    expect(config.testPathPatterns.length).toBeGreaterThan(0);
    expect(config.assetExtensions).toContain(".css");
    expect(config.sourceExtensions).toContain(".ts");
    // Defaults the fixture does not set.
    expect(config.graph.tsPreCompilationDeps).toBe(true);
    expect(config.portfolio.weights.domainCrossing).toBeLessThan(0);
    expect(config.applications[0]!.compilerProfile.lib).toEqual(["lib.es2022.d.ts"]);
    // The fixture declares one artifact: a ledger the widget extraction
    // invalidates. `triggers` is what decides that, and `timeoutMs` is a
    // default the fixture does not set.
    expect(config.generatedArtifacts.artifacts).toEqual([
      {
        path: "generated/module-ledger.json",
        source: "apps/web/src",
        regenerate: "sh scripts/module-ledger.sh",
        triggers: ["^apps/web/src/widgets/"],
      },
    ]);
    expect(config.generatedArtifacts.timeoutMs).toBeGreaterThan(0);
    expect(config.planDir).toContain(TOOL_NAME);
  });

  test("does not guess test, asset, or guarded-branch conventions", () => {
    const config = parseConfig({
      applications: [
        {
          name: "web",
          sourceRoot: "apps/web/src",
          tsconfig: "apps/web/tsconfig.json",
          scaffoldTemplates: { packageJson: { contents: '{"name":"application"}' } },
        },
      ],
      packageRoots: ["libs"],
      scaffoldTemplates: { packageJson: { contents: "{}" } },
    });

    // A repository that calls a source file `thing.test.ts`, imports an asset,
    // or protects an integration branch needs to say so. If any of these
    // assertions failed, the engine would be quietly applying a convention
    // inherited from another workspace.
    expect(config.testPathPatterns).toEqual([]);
    expect(config.sourceExtensions).toContain(".tsx");
    expect(config.assetExtensions).toEqual([]);
    expect(config.guardedBranches).toEqual([]);
    expect(config.transaction.allowDirtyPaths).toEqual([]);
    expect(config.portfolio.protectedPaths).toEqual([]);
    expect(config.scaffoldTemplates.publicSurface).toEqual({ mode: "barrel" });
    expect(isTestPath(config, "apps/web/src/thing.test.ts")).toBe(false);
    expect(isAssetPath(config, "apps/web/src/thing.css")).toBe(false);
    expect(isGuardedBranch(config, "main")).toBe(false);
  });

  test("derived helpers read from config, never from hardcoded assumptions", async () => {
    const { config } = await loadConfig({ cwd: FIXTURE });

    expect(getApplication(config, "web").sourceRoot).toBe("apps/web/src");
    expect(() => getApplication(config, "nope")).toThrow(ConfigError);
    expect(applicationFor(config, "apps/web/src/main.ts")?.name).toBe("web");
    expect(applicationFor(config, "libs/format/src/index.ts")).toBeNull();

    expect(isTestPath(config, "apps/web/src/widgets/chart.test.ts")).toBe(true);
    expect(isTestPath(config, "apps/web/src/widgets/chart.ts")).toBe(false);
    expect(isAssetPath(config, "apps/web/src/widgets/chart.css")).toBe(true);

    expect(scopedPackageName(config, "chart")).toBe("@acme/chart");
    expect(scopedPackageName(config, "@acme/chart")).toBe("@acme/chart");
    expect(packageNameMatcher(config).test("@acme/chart")).toBe(true);
    expect(packageNameMatcher(config).test("chart")).toBe(false);

    expect(isGuardedBranch(config, "main")).toBe(true);
    expect(isGuardedBranch(config, "feature/carve-chart")).toBe(false);

    // Longest-first so a nested source root wins over the package root it sits in.
    expect(firstPartyRoots(config)).toEqual(["apps/web/src/", "apps/api/src/", "libs/"]);
    expect(movableRoots(config)).toContain("libs/");
  });

  test("per-application scaffold overrides fall back to the root templates", () => {
    const config = parseConfig({
      applications: [
        {
          name: "web",
          sourceRoot: "apps/web/src",
          tsconfig: "apps/web/tsconfig.json",
          scaffoldTemplates: { packageJson: { contents: '{"name":"override"}' } },
        },
        { name: "api", sourceRoot: "apps/api/src", tsconfig: "apps/api/tsconfig.json" },
      ],
      packageRoots: ["libs"],
      scaffoldTemplates: {
        packageJson: { contents: '{"name":"root"}' },
        entrypoint: "src/main.ts",
        publicSurface: {
          mode: "subpaths",
          keyTemplate: "./{pathNoExtension}",
          targetTemplate: "./src/{path}",
        },
      },
    });

    const web = scaffoldFor(config, config.applications[0]!);
    expect(web.packageJson).toEqual({ contents: '{"name":"override"}' });
    expect(web.entrypoint).toBe("src/main.ts");
    expect(web.publicSurface).toEqual({
      mode: "subpaths",
      keyTemplate: "./{pathNoExtension}",
      targetTemplate: "./src/{path}",
    });
    expect(scaffoldFor(config, config.applications[1]!).packageJson).toEqual({ contents: '{"name":"root"}' });
  });

  test("rejects firstPartyPackages roots that overlap another root, ancestor or descendant", () => {
    const base = {
      applications: [{ name: "web", sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json" }],
      packageRoots: ["libs"],
      scaffoldTemplates: { packageJson: { contents: '{"name":"root"}' } },
    };
    // Equal to a packageRoots entry.
    expect(() => parseConfig({ ...base, firstPartyPackages: [{ root: "libs", name: "@acme/libs" }] }, "<test>")).toThrow(/overlap/);
    // Descendant of a packageRoots entry.
    expect(() => parseConfig({ ...base, firstPartyPackages: [{ root: "libs/nested", name: "@acme/nested" }] }, "<test>")).toThrow(/overlap/);
    // Ancestor of another firstPartyPackages entry.
    expect(() =>
      parseConfig({ ...base, firstPartyPackages: [{ root: "shared", name: "@acme/shared" }, { root: "shared/inner", name: "@acme/inner" }] }, "<test>"),
    ).toThrow(/overlap/);
    // Two firstPartyPackages entries at the same root.
    expect(() =>
      parseConfig({ ...base, firstPartyPackages: [{ root: "shared", name: "@acme/shared" }, { root: "shared", name: "@acme/dup" }] }, "<test>"),
    ).toThrow(/overlap/);
    // A disjoint root is accepted.
    const ok = parseConfig({ ...base, firstPartyPackages: [{ root: "shared", name: "@acme/shared" }] }, "<test>");
    expect(ok.firstPartyPackages).toEqual([{ root: "shared", name: "@acme/shared" }]);
  });

  test("rejects invalid configs with path-precise messages", () => {
    expect(() => parseConfig({}, "<test>")).toThrow(ConfigError);
    expect(() =>
      parseConfig(
        {
          applications: [{ name: "web", sourceRoot: "/abs/path", tsconfig: "tsconfig.json" }],
          packageRoots: ["libs"],
          scaffoldTemplates: { packageJson: { contents: "{}" } },
        },
        "<test>",
      ),
    ).toThrow(/sourceRoot/);

    expect(() =>
      parseConfig({
        applications: [{ name: "web", sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json" }],
        packageRoots: ["libs"],
        scaffoldTemplates: { packageJson: { contents: "{}" } },
        commitTemplates: { move: "refactor: move\nand more" },
      }),
    ).toThrow(/single line/);

    expect(() =>
      parseConfig({
        applications: [{ name: "web", sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json" }],
        packageRoots: ["libs"],
        scaffoldTemplates: { packageJson: { contents: "{}" } },
        testPathPatterns: ["("],
      }),
    ).toThrow(/regular expression/);

    expect(() =>
      parseConfig({
        applications: [{ name: "web", sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json" }],
        packageRoots: ["libs"],
        scaffoldTemplates: { packageJson: { contents: "{}" } },
        portfolio: { protectedPaths: ["../secret"] },
      }),
    ).toThrow(/protectedPaths/);

    expect(() =>
      parseConfig({
        applications: [{ name: "web", sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json" }],
        packageRoots: ["libs"],
        scaffoldTemplates: { packageJson: { contents: "{}" } },
        moduleSpecifierCalls: ['vi["mock"]'],
      }),
    ).toThrow(/moduleSpecifierCalls/);

    expect(() =>
      parseConfig({
        applications: [{ name: "web", sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json" }],
        packageRoots: ["libs"],
        scaffoldTemplates: {
          packageJson: { contents: "{}" },
          publicSurface: {
            mode: "subpaths",
            keyTemplate: "./{filename}",
            targetTemplate: "./src/{path}",
          },
        },
      }),
    ).toThrow(/unknown module placeholder.*filename/);
  });

  test("normalizes protected paths at the config boundary", () => {
    const config = parseConfig({
      applications: [
        {
          name: "web",
          sourceRoot: "apps/web/src",
          tsconfig: "apps/web/tsconfig.json",
          scaffoldTemplates: { packageJson: { contents: '{"name":"application"}' } },
        },
      ],
      packageRoots: ["libs"],
      scaffoldTemplates: { packageJson: { contents: "{}" } },
      portfolio: { protectedPaths: ["./apps\\web/src/widgets/"] },
    });
    expect(config.portfolio.protectedPaths).toEqual(["apps/web/src/widgets"]);
  });

  test.each(["/", "\\", "C:\\"])('refuses root-like protected path %p', (protectedPath) => {
    expect(() =>
      parseConfig({
        applications: [{ name: "web", sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json" }],
        packageRoots: ["libs"],
        scaffoldTemplates: { packageJson: { contents: "{}" } },
        portfolio: { protectedPaths: [protectedPath] },
      }),
    ).toThrow(/protectedPaths/);
  });

});
