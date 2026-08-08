import { afterAll, describe, expect, test } from "bun:test";

import { moonAdapter } from "../src/adapters/moon.ts";
import { pnpmAdapter } from "../src/adapters/pnpm.ts";
import type { TaskRunnerAdapter } from "../src/adapters/types.ts";
import { fixtureConfig, fixtureRepo, cleanupFixtures } from "./support/fixture-repo.ts";
import { WorkspaceContext } from "../src/plan/context.ts";
import { packageOperations } from "../src/plan/scaffold.ts";
import { PlanningError } from "../src/plan/context.ts";
import type { PublicModule } from "../src/plan/manifest.ts";

const PUBLIC_MODULE: PublicModule = {
  source: "apps/api/src/widgets/chart.ts",
  target: "libs/new-package/src/widgets/chart.ts",
  specifier: "@acme/new-package/widgets/chart",
  exportKey: "./widgets/chart",
  exportTarget: "./src/widgets/chart.ts",
  requiredExports: [{ name: "Chart", typeOnly: false }],
};

function existingPackageOperations(manifest: Record<string, unknown>, publicModule: PublicModule = PUBLIC_MODULE) {
  const root = fixtureRepo({
    "libs/new-package/package.json": `${JSON.stringify(manifest, null, 2)}\n`,
  });
  const config = fixtureConfig(root);
  return packageOperations({
    context: new WorkspaceContext(config, root),
    config,
    application: config.applications[0]!,
    packageManager: pnpmAdapter,
    taskRunner: moonAdapter,
    packageName: "@acme/new-package",
    packageRoot: "libs/new-package",
    projectId: "new-package",
    production: [],
    dependencies: { runtime: {}, dev: {}, packageReferences: [] },
    publicModules: [publicModule],
  });
}

function writtenPackageJson(operations: ReturnType<typeof existingPackageOperations>): Record<string, unknown> {
  const operation = operations.find(
    (entry) => entry.kind === "write-file" && entry.path === "libs/new-package/package.json",
  );
  if (operation?.kind !== "write-file") throw new Error("expected package.json scaffold operation");
  return JSON.parse(operation.contents) as Record<string, unknown>;
}

describe("package scaffold", () => {
  afterAll(cleanupFixtures);

  test("keeps a subpaths-only package entrypoint inert", () => {
    const root = fixtureRepo({
      "apps/api/src/browser.ts": "window.addEventListener('load', () => undefined);\n",
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - libs/*\n",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n",
    });
    const config = fixtureConfig(root, {
      scaffoldTemplates: {
        packageJson: { contents: '{"name":"{package}"}\n' },
        publicSurface: {
          mode: "subpaths",
          keyTemplate: "./{pathNoExtension}",
          targetTemplate: "./src/{path}",
        },
      },
    });
    const operations = packageOperations({
      context: new WorkspaceContext(config, root),
      config,
      application: config.applications[0]!,
      packageManager: pnpmAdapter,
      taskRunner: {
        id: "fixture",
        projectFileName: null,
        projectRegistryFileName: null,
        projectIdFor: (name) => name,
        projectIdOf: () => "",
        registerProject: () => ({ kind: "already-satisfied" }),
        wrapGateCommand: (command) => ["sh", "-c", command],
      },
      packageName: "@acme/browser-ui",
      packageRoot: "libs/browser-ui",
      projectId: "browser-ui",
      production: ["apps/api/src/browser.ts"],
      dependencies: { runtime: {}, dev: {}, packageReferences: [] },
      publicModules: [{
        source: "apps/api/src/browser.ts",
        target: "libs/browser-ui/src/browser.ts",
        specifier: "@acme/browser-ui/browser",
        exportKey: "./browser",
        exportTarget: "./src/browser.ts",
        requiredExports: [],
      }],
    });

    expect(operations).toContainEqual(expect.objectContaining({
      kind: "write-file",
      path: "libs/browser-ui/src/index.ts",
      contents: "",
      generator: "scaffold:entrypoint",
    }));
  });

  test("replaces a false side-effects claim when configured assets move", () => {
    const root = fixtureRepo({ "README.md": "fixture\n", "pnpm-workspace.yaml": "packages:\n  - libs/*\n", "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n" });
    const config = fixtureConfig(root, {
      assetExtensions: [".css", ".svg"],
      scaffoldTemplates: { packageJson: { contents: '{"name":"{package}","sideEffects":false}\n' } },
    });
    const operations = packageOperations({
      context: new WorkspaceContext(config, root), config, application: config.applications[0]!,
      packageManager: pnpmAdapter, taskRunner: {
        id: "fixture", projectFileName: null, projectRegistryFileName: null,
        projectIdFor: (name) => name, projectIdOf: () => "",
        registerProject: () => ({ kind: "already-satisfied" }), wrapGateCommand: (command) => ["sh", "-c", command],
      }, packageName: "@acme/new-package",
      packageRoot: "libs/new-package", projectId: "new-package", production: [],
      assets: ["apps/api/src/theme.css"], dependencies: { runtime: {}, dev: {}, packageReferences: [] },
    });
    expect(writtenPackageJson(operations)).toMatchObject({ sideEffects: ["**/*.css"] });
  });

  test("converts a bare root export before adding module subpaths", () => {
    const manifest = writtenPackageJson(existingPackageOperations({
      name: "@acme/new-package",
      exports: "./src/index.ts",
      dependencies: {},
      devDependencies: {},
    }));

    expect(manifest.exports).toEqual({
      ".": "./src/index.ts",
      "./widgets/chart": "./src/widgets/chart.ts",
    });
  });

  test("preserves root conditions and unrelated wildcard exports", () => {
    const rootConditions = {
      types: "./src/index.ts",
      import: "./src/index.ts",
      default: "./src/index.ts",
    };
    const conditional = writtenPackageJson(existingPackageOperations({
      name: "@acme/new-package",
      exports: rootConditions,
      dependencies: {},
      devDependencies: {},
    }));
    expect(conditional.exports).toEqual({
      ".": rootConditions,
      "./widgets/chart": "./src/widgets/chart.ts",
    });

    const mapped = writtenPackageJson(existingPackageOperations({
      name: "@acme/new-package",
      exports: {
        ".": rootConditions,
        "./legacy/*": "./src/legacy/*.ts",
      },
      dependencies: {},
      devDependencies: {},
    }));
    expect(mapped.exports).toEqual({
      ".": rootConditions,
      "./legacy/*": "./src/legacy/*.ts",
      "./widgets/chart": "./src/widgets/chart.ts",
    });
  });

  test("accepts an identical subpath idempotently and refuses a conflict", () => {
    const manifest = {
      name: "@acme/new-package",
      exports: {
        ".": "./src/index.ts",
        "./widgets/chart": "./src/widgets/chart.ts",
      },
      dependencies: {},
      devDependencies: {},
    };
    expect(existingPackageOperations(manifest)).toEqual([]);

    expect(() => existingPackageOperations({
      ...manifest,
      exports: { ...manifest.exports, "./widgets/chart": "./src/other.ts" },
    })).toThrow(
      new PlanningError(
        'libs/new-package/package.json export ./widgets/chart already targets "./src/other.ts", not "./src/widgets/chart.ts"',
      ),
    );
  });

  test("refuses an existing exports object that mixes conditions and subpaths", () => {
    expect(() => existingPackageOperations({
      name: "@acme/new-package",
      exports: { import: "./src/index.ts", "./legacy": "./src/legacy.ts" },
      dependencies: {},
      devDependencies: {},
    })).toThrow(
      new PlanningError("libs/new-package/package.json exports cannot mix package subpaths and root conditions"),
    );
  });

  test("registers through an adapter-owned project registry path", () => {
    const root = fixtureRepo({
      "runner/projects.conf": "projects = []\n",
      "pnpm-workspace.yaml": "packages:\n  - libs/*\n",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n",
    });
    const config = fixtureConfig(root);
    const context = new WorkspaceContext(config, root);
    const taskRunner: TaskRunnerAdapter = {
      id: "fixture-runner",
      projectFileName: null,
      projectRegistryFileName: "runner/projects.conf",
      projectIdFor: (packageName) => packageName,
      projectIdOf: (_rootDir, packageRoot) => packageRoot,
      registerProject: (text, packageRoot, projectId) => ({
        kind: "changed",
        contents: `${text}register ${projectId} ${packageRoot}\n`,
      }),
      wrapGateCommand: (command) => ["sh", "-c", command],
    };

    const operations = packageOperations({
      context,
      config,
      application: config.applications[0]!,
      packageManager: pnpmAdapter,
      taskRunner,
      packageName: "@acme/new-package",
      packageRoot: "libs/new-package",
      projectId: "new-package",
      production: [],
      dependencies: { runtime: {}, dev: {}, packageReferences: [] },
    });

    const registration = operations.find(
      (operation) => operation.kind === "write-file" && operation.generator === "scaffold:project-registration",
    );
    expect(registration).toMatchObject({
      kind: "write-file",
      path: "runner/projects.conf",
      contents: "projects = []\nregister new-package libs/new-package\n",
    });
  });

  test("refuses an adapter precondition it cannot satisfy", () => {
    const root = fixtureRepo({
      "runner/projects.conf": "projects = []\n",
      "pnpm-workspace.yaml": "packages:\n  - libs/*\n",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n",
    });
    const config = fixtureConfig(root);
    const context = new WorkspaceContext(config, root);
    const taskRunner: TaskRunnerAdapter = {
      id: "fixture-runner",
      projectFileName: null,
      projectRegistryFileName: "runner/projects.conf",
      projectIdFor: (packageName) => packageName,
      projectIdOf: (_rootDir, packageRoot) => packageRoot,
      registerProject: () => ({
        kind: "unmet-precondition",
        reason: "the fixture registry cannot accept new projects",
      }),
      wrapGateCommand: (command) => ["sh", "-c", command],
    };

    expect(() =>
      packageOperations({
        context,
        config,
        application: config.applications[0]!,
        packageManager: pnpmAdapter,
        taskRunner,
        packageName: "@acme/new-package",
        packageRoot: "libs/new-package",
        projectId: "new-package",
        production: [],
        dependencies: { runtime: {}, dev: {}, packageReferences: [] },
      }),
    ).toThrow(new PlanningError("scaffold:project-registration cannot update runner/projects.conf: the fixture registry cannot accept new projects"));
  });

  test("does not emit registration when an adapter verifies it is already satisfied", () => {
    const root = fixtureRepo({
      "runner/projects.conf": "projects = []\n",
      "pnpm-workspace.yaml": "packages:\n  - libs/*\n",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n",
    });
    const config = fixtureConfig(root);
    const context = new WorkspaceContext(config, root);
    let registrations = 0;
    const taskRunner: TaskRunnerAdapter = {
      id: "fixture-runner",
      projectFileName: null,
      projectRegistryFileName: "runner/projects.conf",
      projectIdFor: (packageName) => packageName,
      projectIdOf: (_rootDir, packageRoot) => packageRoot,
      registerProject: () => {
        registrations += 1;
        return { kind: "already-satisfied" };
      },
      wrapGateCommand: (command) => ["sh", "-c", command],
    };

    const operations = packageOperations({
      context,
      config,
      application: config.applications[0]!,
      packageManager: pnpmAdapter,
      taskRunner,
      packageName: "@acme/new-package",
      packageRoot: "libs/new-package",
      projectId: "new-package",
      production: [],
      dependencies: { runtime: {}, dev: {}, packageReferences: [] },
    });

    expect(operations.some((operation) => operation.kind === "write-file" && operation.generator === "scaffold:project-registration")).toBe(false);
    expect(registrations).toBe(1);
  });

  test("refuses when a required project registry file is absent", () => {
    const root = fixtureRepo({
      "pnpm-workspace.yaml": "packages:\n  - libs/*\n",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n",
    });
    const config = fixtureConfig(root);
    const context = new WorkspaceContext(config, root);

    expect(() =>
      packageOperations({
        context,
        config,
        application: config.applications[0]!,
        packageManager: pnpmAdapter,
        taskRunner: {
          id: "fixture-runner",
          projectFileName: null,
          projectRegistryFileName: "runner/projects.conf",
          projectIdFor: (packageName) => packageName,
          projectIdOf: (_rootDir, packageRoot) => packageRoot,
          registerProject: () => ({ kind: "already-satisfied" }),
          wrapGateCommand: (command) => ["sh", "-c", command],
        },
        packageName: "@acme/new-package",
        packageRoot: "libs/new-package",
        projectId: "new-package",
        production: [],
        dependencies: { runtime: {}, dev: {}, packageReferences: [] },
      }),
    ).toThrow(new PlanningError("runner/projects.conf is required to register project new-package"));
  });

  test("refuses an adapter that labels identical contents as changed", () => {
    const root = fixtureRepo({
      "runner/projects.conf": "projects = []\n",
      "pnpm-workspace.yaml": "packages:\n  - libs/*\n",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n",
    });
    const config = fixtureConfig(root);
    const context = new WorkspaceContext(config, root);

    expect(() =>
      packageOperations({
        context,
        config,
        application: config.applications[0]!,
        packageManager: pnpmAdapter,
        taskRunner: {
          id: "fixture-runner",
          projectFileName: null,
          projectRegistryFileName: "runner/projects.conf",
          projectIdFor: (packageName) => packageName,
          projectIdOf: (_rootDir, packageRoot) => packageRoot,
          registerProject: (contents) => ({ kind: "changed", contents }),
          wrapGateCommand: (command) => ["sh", "-c", command],
        },
        packageName: "@acme/new-package",
        packageRoot: "libs/new-package",
        projectId: "new-package",
        production: [],
        dependencies: { runtime: {}, dev: {}, packageReferences: [] },
      }),
    ).toThrow(new PlanningError("scaffold:project-registration reported a change to runner/projects.conf without changing its contents"));
  });

  test("refuses to scaffold without the required lockfile", () => {
    const root = fixtureRepo({
      ".gitignore": "node_modules\n",
      "pnpm-workspace.yaml": "packages:\n  - libs/*\n",
    });
    const config = fixtureConfig(root);
    const context = new WorkspaceContext(config, root);

    expect(() =>
      packageOperations({
        context,
        config,
        application: config.applications[0]!,
        packageManager: pnpmAdapter,
        taskRunner: {
          id: "fixture-runner",
          projectFileName: null,
          projectRegistryFileName: null,
          projectIdFor: (packageName) => packageName,
          projectIdOf: (_rootDir, packageRoot) => packageRoot,
          registerProject: () => ({ kind: "already-satisfied" }),
          wrapGateCommand: (command) => ["sh", "-c", command],
        },
        packageName: "@acme/new-package",
        packageRoot: "libs/new-package",
        projectId: "new-package",
        production: [],
        dependencies: { runtime: {}, dev: {}, packageReferences: [] },
      }),
    ).toThrow(new PlanningError("pnpm-lock.yaml is required to add an importer for libs/new-package"));
  });

  test("refuses to scaffold when required workspace membership cannot be checked", () => {
    const root = fixtureRepo({
      ".gitignore": "node_modules\n",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n",
    });
    const config = fixtureConfig(root);
    const context = new WorkspaceContext(config, root);

    expect(() =>
      packageOperations({
        context,
        config,
        application: config.applications[0]!,
        packageManager: pnpmAdapter,
        taskRunner: {
          id: "fixture-runner",
          projectFileName: null,
          projectRegistryFileName: null,
          projectIdFor: (packageName) => packageName,
          projectIdOf: (_rootDir, packageRoot) => packageRoot,
          registerProject: () => ({ kind: "already-satisfied" }),
          wrapGateCommand: (command) => ["sh", "-c", command],
        },
        packageName: "@acme/new-package",
        packageRoot: "libs/new-package",
        projectId: "new-package",
        production: [],
        dependencies: { runtime: {}, dev: {}, packageReferences: [] },
      }),
    ).toThrow(new PlanningError("pnpm-workspace.yaml is required to register libs/new-package as a workspace package"));
  });

});
