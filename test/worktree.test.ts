/**
 * The simulation worktree's `node_modules` strategy.
 *
 * `transaction.nodeModules` defaults to `symlink`, so this is the path almost
 * every real simulation takes — and the one whose failure mode is quietest. A
 * link that is not made does not raise anything: the gate simply fails on a
 * module it cannot resolve, and the simulation reports that as if the
 * extraction were at fault. So the cases below assert the links themselves, not
 * "the simulation was green", and each one has a matching negative: a
 * dependency that resolves nowhere must come back as a name, and the primary
 * checkout must be provably unchanged afterwards.
 *
 * What is *not* covered here, deliberately: `nodeModules: "install"` never runs
 * a real package manager. Requiring `pnpm` on PATH would make the suite
 * machine-dependent, and installing a real dependency tree per test would cost
 * minutes. The install path is split into the three things that are checkable
 * without one — that `createWorktree` runs the command it is given, in the
 * worktree; that a command which fails is fatal rather than absorbed; and that
 * the adapter's command is what the simulation hands it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { pnpmAdapter } from "../src/adapters/pnpm.ts";
import { rewriteResolvedImportSpecifier } from "../src/codemod/imports.ts";
import { simulatePlan } from "../src/transaction/simulate.ts";
import { createWorktree, installWorkspaceDependencies, linkPlannedPackage, WorktreeError } from "../src/transaction/worktree.ts";
import { hashText } from "../src/util/hash.ts";
import type { ExtractionManifest, PlanOperation } from "../src/plan/manifest.ts";
import { cleanupFixtures, fixtureConfig, fixtureGit, fixtureRepo, read, scratchDirectory, write } from "./support/fixture-repo.ts";

const PACKAGE = "@acme/analytics";
const PACKAGE_ROOT = "libs/analytics";
const DONOR = "apps/api/src/widget/widget.ts";
const TARGET = "libs/analytics/src/widget/widget.ts";
const CONSUMER = "apps/api/src/consumer.ts";
const ENTRYPOINT = "libs/analytics/src/index.ts";

function packageManifest(name: string, dependencies: Record<string, string> = {}): string {
  return `${JSON.stringify(
    {
      name,
      version: "0.1.0",
      private: true,
      type: "module",
      main: "./src/index.ts",
      types: "./src/index.ts",
      exports: { ".": { types: "./src/index.ts", import: "./src/index.ts", default: "./src/index.ts" } },
      ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
    },
    null,
    2,
  )}\n`;
}

function workspaceFiles(dependencies: Record<string, string> = {}): Record<string, string> {
  return {
    "package.json": `${JSON.stringify({ name: "fixture-workspace", private: true, type: "module" }, null, 2)}\n`,
    "apps/api/package.json": packageManifest("@acme/api"),
    "apps/api/tsconfig.json": `${JSON.stringify({ include: ["src"] }, null, 2)}\n`,
    "apps/web/package.json": packageManifest("@acme/web"),
    [DONOR]: "export const widgetValue = 1;\n",
    [CONSUMER]: 'import { widgetValue } from "./widget/widget.ts";\n\nexport const used = widgetValue + 1;\n',
    [`${PACKAGE_ROOT}/package.json`]: packageManifest(PACKAGE, dependencies),
  };
}

/**
 * A pnpm-shaped installation: the real directory sits in a content-addressed
 * store and `node_modules/<name>` is a symlink into it. The indirection is the
 * point — the worktree ends up holding a link to a link, and every assertion
 * below on where a link *lands* is what proves `realpathSync` collapses that.
 * Returns the store path, which is what a correct link resolves to.
 */
function installPackage(root: string, owner: string, name: string): string {
  const store = join(root, "node_modules", ".store", `${name.replace("/", "+")}@1.0.0`, "node_modules", name);
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, "package.json"), `${JSON.stringify({ name, version: "1.0.0", main: "index.js" })}\n`);
  writeFileSync(join(store, "index.js"), `module.exports = ${JSON.stringify(name)};\n`);
  const link = join(root, owner, "node_modules", name);
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(store, link, "dir");
  return realpathSync(store);
}

/**
 * Only the fields {@link linkPlannedPackage} reads. The rest of a manifest has
 * no bearing on which links it makes, and inventing it would suggest otherwise.
 */
function linkingManifest(owners: readonly string[]): ExtractionManifest {
  return {
    target: { packageName: PACKAGE, packageRoot: PACKAGE_ROOT },
    consumers: owners.map((owner) => ({ owner })),
  } as unknown as ExtractionManifest;
}

function head(root: string): string {
  return fixtureGit(root, "rev-parse", "HEAD");
}

async function symlinkedWorktree(root: string) {
  return createWorktree({
    rootDir: root,
    commit: head(root),
    worktreeRoot: scratchDirectory(),
    nodeModules: "symlink",
    label: "worktree-fixture",
  });
}

describe("simulation worktree node_modules", () => {
  afterEach(cleanupFixtures);

  test("symlink mode links node_modules entry by entry, in every workspace it finds", async () => {
    const root = fixtureRepo(workspaceFiles());
    const rootStore = installPackage(root, ".", "left-pad");
    const appStore = installPackage(root, "apps/api", "@acme/dep");

    const worktree = await symlinkedWorktree(root);

    // The checkout is real and at the plan's commit, not a copy of the tree.
    expect(read(worktree.path, DONOR)).toBe("export const widgetValue = 1;\n");
    expect(worktree.commit).toBe(head(root));

    // Entry by entry, not the directory: `node_modules` itself must stay a real
    // directory, or a later `linkPackage` would write into the checkout.
    for (const directory of ["node_modules", "apps/api/node_modules"]) {
      expect(lstatSync(join(worktree.path, directory)).isSymbolicLink()).toBe(false);
      expect(lstatSync(join(worktree.path, directory)).isDirectory()).toBe(true);
    }

    // Each entry resolves to the store the primary checkout resolves to. The
    // primary's own `node_modules/left-pad` is itself a symlink, so this is the
    // link-to-link case the docstring claims `realpathSync` handles.
    const linked = join(worktree.path, "node_modules", "left-pad");
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(realpathSync(linked)).toBe(rootStore);
    expect(readFileSync(join(linked, "index.js"), "utf8")).toBe('module.exports = "left-pad";\n');

    // Depth: a nested workspace's `node_modules` is linked too, scope and all.
    const nested = join(worktree.path, "apps/api/node_modules/@acme/dep");
    expect(realpathSync(nested)).toBe(appStore);

    await worktree.dispose();
    expect(existsSync(worktree.path)).toBe(false);
    expect(fixtureGit(root, "worktree", "list")).not.toContain(worktree.path);
  }, 60_000);

  /**
   * A worktree borrows its repository's common git dir, so `worktree add` runs
   * the *shared* `post-checkout` hook. Hooks written for a developer's worktree
   * treat the new tree as durable and start work against it — indexers, in
   * practice — detached, and outliving the process that created it. The
   * simulation tree is deleted minutes later, so that work is left running
   * against a path that no longer exists, and nothing here can signal it.
   *
   * The assertion is the hook's side effect rather than a git flag, because the
   * flag is only ever right by accident: what matters is that nothing in the
   * repository observes this checkout.
   */
  test("creating the worktree runs no repository hook", async () => {
    const root = fixtureRepo(workspaceFiles());
    const witness = join(root, "post-checkout-ran");
    const hook = join(root, ".git/hooks/post-checkout");
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, `#!/bin/sh\necho ran > ${JSON.stringify(witness)}\n`);
    chmodSync(hook, 0o755);

    const worktree = await symlinkedWorktree(root);

    expect(existsSync(witness)).toBe(false);

    await worktree.dispose();
  }, 60_000);

  /**
   * The quietest failure this file exists to catch. A first-party package is
   * linked, not installed, so mirroring its link verbatim points the worktree
   * back at the developer's current `libs/` — and the gates then typecheck the
   * code the extraction was supposed to change, from the tree it was supposed
   * not to touch. It looks like a working simulation and proves nothing.
   */
  test("a workspace package link resolves inside the worktree, not back into the checkout", async () => {
    const root = fixtureRepo(workspaceFiles());
    const store = installPackage(root, "apps/api", "@acme/dep");
    // How a workspace links a sibling: `node_modules/<name>` -> the source
    // directory in the same repository, next to the published packages.
    symlinkSync(join(root, PACKAGE_ROOT), join(root, "apps/api/node_modules", PACKAGE), "dir");

    const worktree = await symlinkedWorktree(root);

    const linked = join(worktree.path, "apps/api/node_modules", PACKAGE);
    expect(realpathSync(linked)).toBe(realpathSync(join(worktree.path, PACKAGE_ROOT)));
    expect(realpathSync(linked)).not.toBe(realpathSync(join(root, PACKAGE_ROOT)));
    // Reading through the link reaches the worktree's copy of the manifest.
    expect(JSON.parse(readFileSync(join(linked, "package.json"), "utf8")).name).toBe(PACKAGE);

    // The published package it shares a scope directory with is untouched: only
    // first-party source is redirected, never the store.
    expect(realpathSync(join(worktree.path, "apps/api/node_modules/@acme/dep"))).toBe(store);

    await worktree.dispose();
  }, 60_000);

  test("a symlink into a sibling whose name shares the checkout prefix stays external", async () => {
    const root = fixtureRepo(workspaceFiles());
    const sibling = `${root}-sibling`;
    const siblingPackage = join(sibling, "packages", "external");
    const externalLink = join(root, "apps/api/node_modules/@acme/external");
    mkdirSync(siblingPackage, { recursive: true });
    writeFileSync(join(siblingPackage, "package.json"), packageManifest("@acme/external"));
    mkdirSync(dirname(externalLink), { recursive: true });
    symlinkSync(siblingPackage, externalLink, "dir");

    try {
      const worktree = await symlinkedWorktree(root);
      const linked = join(worktree.path, "apps/api/node_modules/@acme/external");

      // `/tmp/repo-sibling` starts with `/tmp/repo`, but `relative()` says it
      // leaves the checkout. Rewriting it would create a broken worktree link
      // and make an external installed dependency look like first-party source.
      expect(realpathSync(linked)).toBe(realpathSync(siblingPackage));
      expect(realpathSync(linked)).not.toContain(worktree.path);

      await worktree.dispose();
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  }, 60_000);

  test("links the planned package into each consumer owner and its resolvable dependencies into itself", async () => {
    const root = fixtureRepo(workspaceFiles({ "left-pad": "^1.0.0", "@acme/dep": "^1.0.0" }));
    const rootStore = installPackage(root, ".", "left-pad");
    const appStore = installPackage(root, "apps/api", "@acme/dep");
    const before = readdirSync(join(root, "apps/api/node_modules/@acme")).sort();

    const worktree = await symlinkedWorktree(root);
    const unlinked = linkPlannedPackage(worktree.workspacePath, linkingManifest(["apps/api", "apps/web", "apps/api"]));

    expect(unlinked).toEqual([]);

    // One link per distinct owner that is really a package, pointing at the
    // package the plan creates inside this worktree.
    for (const owner of ["apps/api", "apps/web"]) {
      const link = join(worktree.workspacePath, owner, "node_modules", PACKAGE);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(join(worktree.workspacePath, PACKAGE_ROOT));
    }

    // The declared dependencies resolve from inside the new package: one found
    // at the workspace root, one found only under a consuming application.
    expect(realpathSync(join(worktree.workspacePath, PACKAGE_ROOT, "node_modules", "left-pad"))).toBe(rootStore);
    expect(realpathSync(join(worktree.workspacePath, PACKAGE_ROOT, "node_modules", "@acme/dep"))).toBe(appStore);

    // The whole reason entries are linked individually: adding `@acme/analytics`
    // to a scope directory reached through a symlink must not reach back into
    // the developer's checkout.
    expect(readdirSync(join(root, "apps/api/node_modules/@acme")).sort()).toEqual(before);
    expect(existsSync(join(root, "apps/api/node_modules", PACKAGE))).toBe(false);
    expect(existsSync(join(root, PACKAGE_ROOT, "node_modules"))).toBe(false);
  }, 60_000);

  test("reports a declared dependency that resolves nowhere instead of skipping it", async () => {
    const root = fixtureRepo(workspaceFiles({ "left-pad": "^1.0.0", "@acme/nowhere": "workspace:*" }));
    installPackage(root, ".", "left-pad");

    const worktree = await symlinkedWorktree(root);
    const unlinked = linkPlannedPackage(worktree.workspacePath, linkingManifest(["apps/api"]));

    // Silence here is what makes a gate failure unreadable: the package cannot
    // resolve `@acme/nowhere`, the gate dies on a resolution error, and the
    // simulation blames the extraction for its own missing setup.
    expect(unlinked).toEqual(["@acme/nowhere"]);
    expect(existsSync(join(worktree.workspacePath, PACKAGE_ROOT, "node_modules", "@acme/nowhere"))).toBe(false);
    // The dependency that *was* resolvable is still linked; one missing name
    // does not abandon the rest.
    expect(existsSync(join(worktree.workspacePath, PACKAGE_ROOT, "node_modules", "left-pad"))).toBe(true);
  }, 60_000);

  test("carries the unlinkable dependency out of the simulation, without failing it", async () => {
    const root = fixtureRepo(workspaceFiles({ "@acme/nowhere": "workspace:*" }));
    const config = fixtureConfig(root, {
      transaction: { worktreeRoot: scratchDirectory(), nodeModules: "symlink", cleanup: true, simulateGates: true },
    });

    const result = await simulatePlan({ config, rootDir: root, manifest: simulationManifest(root) });

    // A dependency the worktree cannot link is a warning, not a refusal: the
    // repository may well resolve it another way, and hard-failing would make
    // the default mode less usable than the silent version it replaces.
    expect(result.ok).toBe(true);
    expect(result.unlinkedDependencies).toEqual(["@acme/nowhere"]);
  }, 180_000);

  test("simulation audit resolves configured types from an existing application importer", async () => {
    const root = fixtureRepo(workspaceFiles());
    write(root, "apps/api/package.json", `${JSON.stringify({ name: "@acme/api", private: true, devDependencies: { "direct-types": "1.0.0" } })}\n`);
    write(root, "apps/api/tsconfig.json", `${JSON.stringify({ compilerOptions: { types: ["direct-types"] }, include: ["src"] })}\n`);
    write(root, DONOR, "export const widgetValue = directWorkerSignal ? 1 : 0;\n");
    write(root, "apps/api/node_modules/direct-types/package.json", `${JSON.stringify({ name: "direct-types", types: "./index.d.ts" })}\n`);
    write(root, "apps/api/node_modules/direct-types/index.d.ts", "declare const directWorkerSignal: boolean;\n");
    fixtureGit(root, "add", "-A");
    fixtureGit(root, "commit", "-qm", "test: add an application-owned configured type");
    const config = fixtureConfig(root, { transaction: { worktreeRoot: scratchDirectory(), nodeModules: "symlink", cleanup: true, simulateGates: true } });

    const result = await simulatePlan({ config, rootDir: root, manifest: simulationManifest(root) });

    expect(result.ok).toBe(true);
    expect(result.failure).toBeUndefined();
  }, 180_000);

  test("install mode runs the command it is given, in the worktree", async () => {
    const root = fixtureRepo(workspaceFiles());

    // A stand-in for the package manager. What is testable without a real one
    // is the plumbing: that the command runs at all, and that it runs with the
    // worktree as its cwd rather than the primary checkout.
    const worktree = await createWorktree({
      rootDir: root,
      commit: head(root),
      worktreeRoot: scratchDirectory(),
      nodeModules: "install",
      // Chatter on stderr and a zero exit: a package manager that warns is not
      // a package manager that failed, so the check below must key on the exit
      // code alone. This is also what stops "throw always" from passing.
      installCommand: ["sh", "-c", "pwd > installed-in.txt; echo 'WARN deprecated subdependency' >&2"],
      label: "install-fixture",
    });

    expect(read(worktree.path, "installed-in.txt").trim()).toBe(worktree.workspacePath);
    expect(existsSync(join(root, "installed-in.txt"))).toBe(false);
    // Nothing was installed, so nothing may be linked either: install mode and
    // symlink mode are alternatives, not layers.
    expect(existsSync(join(worktree.path, "node_modules"))).toBe(false);

    await worktree.dispose();
  }, 60_000);

  test("a second install sees the package created by the landed plan", async () => {
    const root = fixtureRepo(workspaceFiles());
    const worktree = await createWorktree({
      rootDir: root, commit: head(root), worktreeRoot: scratchDirectory(), nodeModules: "install",
      installCommand: ["sh", "-c", "true"], label: "planned-install-fixture",
    });
    write(worktree.workspacePath, "libs/new-package/package.json", '{"name":"@acme/new-package"}\n');
    installWorkspaceDependencies(worktree.workspacePath, ["sh", "-c", "test -f libs/new-package/package.json && mkdir -p libs/new-package/node_modules/runtime-dependency"]);
    expect(existsSync(join(worktree.workspacePath, "libs/new-package/node_modules/runtime-dependency"))).toBeTrue();
    await worktree.dispose();
  }, 60_000);

  test("install mode refuses a worktree whose install failed, naming the exit code and the error", async () => {
    const root = fixtureRepo(workspaceFiles());
    const worktreeRoot = scratchDirectory();

    // Fatal here, unlike an unlinkable dependency, and the asymmetry is the
    // point: `install` mode is a request for a real dependency tree, so if the
    // install did not happen there is no tree, and any gate run against the
    // worktree would be a green simulation of a broken setup.
    const failed = await createWorktree({
      rootDir: root,
      commit: head(root),
      worktreeRoot,
      nodeModules: "install",
      installCommand: ["sh", "-c", "echo 'install context from stdout'; echo 'ERR_PNPM_OUTDATED_LOCKFILE cannot install with frozen-lockfile' >&2; exit 3"],
      label: "failed-install",
    }).catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(WorktreeError);
    // A human has to be able to see which command failed and why without
    // reading an install log, so both the code and the tail are in the message.
    expect((failed as Error).message).toContain("exit 3");
    expect((failed as Error).message).toContain("install context from stdout");
    expect((failed as Error).message).toContain("ERR_PNPM_OUTDATED_LOCKFILE");

    // A refused worktree leaves nothing behind, on disk or in git's registry.
    expect(readdirSync(worktreeRoot)).toEqual([]);
    expect(fixtureGit(root, "worktree", "list").split("\n")).toHaveLength(1);
  }, 60_000);

  test("install mode refuses to pretend when it has no command, and pnpm's is the command it would get", async () => {
    const root = fixtureRepo(workspaceFiles());
    const worktreeRoot = scratchDirectory();

    await expect(
      createWorktree({ rootDir: root, commit: head(root), worktreeRoot, nodeModules: "install", installCommand: [] }),
    ).rejects.toThrow(WorktreeError);
    // The failed attempt leaves no worktree behind, registered or on disk.
    expect(readdirSync(worktreeRoot)).toEqual([]);
    expect(fixtureGit(root, "worktree", "list").split("\n")).toHaveLength(1);

    // The other half of the install path, asserted without needing pnpm: this
    // is what `simulatePlan` passes as `installCommand`.
    expect(pnpmAdapter.installCommand()).toEqual(["pnpm", "install", "--frozen-lockfile"]);
  }, 60_000);
});

/**
 * A real, replayable plan for the one case that has to go through
 * `simulatePlan`: a move, its consumer rewrite, and the package barrel. Kept
 * here rather than shared, because the transaction suite's fixture is tuned to
 * what the audit proves and this one is tuned to what gets linked.
 */
function simulationManifest(root: string): ExtractionManifest {
  const donorHash = hashText(read(root, DONOR));
  const consumerText = read(root, CONSUMER);
  const rewritten = rewriteResolvedImportSpecifier(consumerText, join(root, CONSUMER), join(root, DONOR), PACKAGE, root);
  const barrel = 'export * from "./widget/widget.ts";\n';

  const operations: PlanOperation[] = [
    { kind: "move", source: DONOR, target: TARGET, preconditionHash: donorHash, resultHash: donorHash },
    {
      kind: "rewrite-import",
      file: CONSUMER,
      donors: [DONOR],
      rewrites: [{ from: "./widget/widget.ts", to: PACKAGE }],
      preconditionHash: hashText(consumerText),
      resultHash: hashText(rewritten),
    },
    {
      kind: "write-file",
      path: ENTRYPOINT,
      contents: barrel,
      preconditionHash: "missing",
      resultHash: hashText(barrel),
      generator: "scaffold:entrypoint",
    },
  ];

  return {
    schemaVersion: 2,
    planId: "worktree-fixture",
    createdAt: new Date().toISOString(),
    generator: { name: "monocarve", version: "0.0.0" },
    baselineCommit: head(root),
    graphDigest: hashText("worktree-graph"),
    application: "api",
    target: {
      packageName: PACKAGE,
      packageRoot: PACKAGE_ROOT,
      entrypoint: "src/index.ts",
      requiredExports: [{ name: "widgetValue", typeOnly: false }],
    },
    source: { files: [DONOR], tests: [], sccs: { "scc-fixture": [DONOR] } },
    dependencies: { runtime: {}, dev: {}, packageReferences: [] },
    sourceBlobs: { [DONOR]: donorHash },
    operations,
    consumers: [
      {
        file: CONSUMER,
        owner: "apps/api",
        expectedImporter: "./widget/widget.ts",
        specifiers: [{ from: "./widget/widget.ts", to: PACKAGE }],
        external: false,
        dependencySection: "runtime",
      },
    ],
    generatedFiles: [],
    changedFiles: [DONOR, TARGET, CONSUMER, ENTRYPOINT].sort(),
    expectedDynamicImportDelta: { added: [], removed: [] },
    evaluationEffects: [],
    metrics: { movedFiles: 1, movedLines: 1, applicationLinesBefore: 4, applicationLinesAfter: 3, consumers: 1 },
    commits: {
      move: { subject: `refactor(${PACKAGE}): move 1 files into ${PACKAGE_ROOT}` },
      wiring: { subject: `refactor(${PACKAGE}): wire ${PACKAGE} into the workspace` },
    },
    gates: { package: [], project: [], workspace: ["true"] },
  };
}
