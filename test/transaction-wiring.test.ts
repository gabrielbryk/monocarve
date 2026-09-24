/** Consumer wiring proof cases. */
import { afterEach, describe, expect, test } from "bun:test";
import { pnpmAdapter } from "../src/adapters/pnpm.ts";
import { createTaskRunnerAdapter } from "../src/adapters/registry.ts";
import { PlanningError, WorkspaceContext } from "../src/plan/context.ts";
import type { ExtractionManifest } from "../src/plan/manifest.ts";
import { consumerWiringOperations } from "../src/plan/scaffold.ts";
import { assertPlanValid } from "../src/plan/validate.ts";
import { applyPlan } from "../src/transaction/apply.ts";
import { auditPlanSync } from "../src/transaction/audit.ts";
import { hashText } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureConfig, fixtureGit, fixtureRepo, read } from "./support/fixture-repo.ts";
import {
  APP,
  CONSUMER,
  ENTRYPOINT,
  LOCKFILE,
  PACKAGE,
  PACKAGE_ROOT,
  ZETA,
  baseManifest,
  extractionFiles,
  importerBlock,
  landManifest,
  packageManifest,
} from "./support/transaction-fixture.ts";

describe("consumer wiring for a newly created package", () => {
  afterEach(cleanupFixtures);

  const WIRING_LOCKFILE = [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .: {}",
    "",
    "  apps/api:",
    "    dependencies:",
    `      '${ZETA}':`,
    "        specifier: workspace:*",
    "        version: link:../../libs/zeta",
    "",
    "  libs/zeta: {}",
    "",
  ].join("\n");

  const TARGET_BLOCK = importerBlock(["  libs/analytics: {}"]);
  const WIRED_APP_BLOCK = importerBlock([
    "  apps/api:",
    "    dependencies:",
    `      '${PACKAGE}':`,
    "        specifier: workspace:*",
    "        version: link:../../libs/analytics",
    `      '${ZETA}':`,
    "        specifier: workspace:*",
    "        version: link:../../libs/zeta",
  ]);

  const APP_MANIFEST = `${JSON.stringify(
    { name: "@acme/api", version: "0.1.0", private: true, type: "module", dependencies: { [ZETA]: "workspace:*" } },
    null,
    2,
  )}\n`;
  const WIRED_APP_MANIFEST = `${JSON.stringify(
    { name: "@acme/api", version: "0.1.0", private: true, type: "module", dependencies: { [PACKAGE]: "workspace:*", [ZETA]: "workspace:*" } },
    null,
    2,
  )}\n`;
  const APP_TSCONFIG = `${JSON.stringify({ include: ["src"], references: [{ path: "../../libs/zeta" }] }, null, 2)}\n`;
  const WIRED_APP_TSCONFIG = `${JSON.stringify({ include: ["src"], references: [{ path: "../../libs/analytics" }, { path: "../../libs/zeta" }] }, null, 2)}\n`;

  function wiringFiles(): Record<string, string> {
    return {
      ...extractionFiles(),
      "pnpm-lock.yaml": WIRING_LOCKFILE,
      [`${APP}/package.json`]: APP_MANIFEST,
      [`${APP}/tsconfig.json`]: APP_TSCONFIG,
      "libs/zeta/package.json": packageManifest(ZETA),
      "libs/zeta/src/index.ts": "export const zeta = 1;\n",
    };
  }

  function wiringManifest(root: string): ExtractionManifest {
    const base = baseManifest(root);
    const afterTarget = pnpmAdapter.insertImporter(WIRING_LOCKFILE, PACKAGE_ROOT, TARGET_BLOCK);
    const afterApp = pnpmAdapter.replaceImporter(afterTarget, APP, WIRED_APP_BLOCK);
    return {
      ...base,
      lockfileImporter: { packageRoot: PACKAGE_ROOT, hash: hashText(TARGET_BLOCK) },
      changedFiles: [...base.changedFiles, `${APP}/package.json`, `${APP}/tsconfig.json`].toSorted(),
      operations: [
        ...base.operations.filter((operation) => operation.kind !== "lockfile-importer"),
        {
          kind: "lockfile-importer",
          lockfile: "pnpm-lock.yaml",
          packageRoot: PACKAGE_ROOT,
          block: TARGET_BLOCK,
          mode: "insert",
          preconditionHash: hashText(WIRING_LOCKFILE),
          resultHash: hashText(afterTarget),
        },
        {
          kind: "write-file",
          path: `${APP}/package.json`,
          contents: WIRED_APP_MANIFEST,
          preconditionHash: hashText(APP_MANIFEST),
          resultHash: hashText(WIRED_APP_MANIFEST),
          generator: "wiring:consumer-dependency",
        },
        {
          kind: "write-file",
          path: `${APP}/tsconfig.json`,
          contents: WIRED_APP_TSCONFIG,
          preconditionHash: hashText(APP_TSCONFIG),
          resultHash: hashText(WIRED_APP_TSCONFIG),
          generator: "wiring:consumer-project-references",
        },
        {
          kind: "lockfile-importer",
          lockfile: "pnpm-lock.yaml",
          packageRoot: APP,
          block: WIRED_APP_BLOCK,
          mode: "replace",
          preconditionHash: hashText(afterTarget),
          resultHash: hashText(afterApp),
        },
      ],
    };
  }

  test("adds the dependency, the project reference, and the app importer block", async () => {
    const root = fixtureRepo(wiringFiles());
    const config = fixtureConfig(root);
    const manifest = wiringManifest(root);
    expect(() => assertPlanValid(manifest, { config, rootDir: root })).not.toThrow();
    const manifestPath = landManifest(root, manifest);

    await applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true });

    expect(read(root, `${APP}/package.json`)).toBe(WIRED_APP_MANIFEST);
    // Sorted insertion, not an append: the new dependency precedes the old one.
    expect(Object.keys(JSON.parse(read(root, `${APP}/package.json`)).dependencies)).toEqual([PACKAGE, ZETA]);
    expect(JSON.parse(read(root, `${APP}/tsconfig.json`)).references).toEqual([{ path: "../../libs/analytics" }, { path: "../../libs/zeta" }]);

    const lockfile = read(root, "pnpm-lock.yaml");
    expect(pnpmAdapter.importerBlock(lockfile, APP)).toBe(WIRED_APP_BLOCK);
    expect(pnpmAdapter.importerBlock(lockfile, PACKAGE_ROOT)).toBe(TARGET_BLOCK);

    const wiring = fixtureGit(root, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).toSorted();
    expect(wiring).toEqual([`${APP}/package.json`, `${APP}/tsconfig.json`, CONSUMER, ENTRYPOINT, "pnpm-lock.yaml"].toSorted());
    expect(auditPlanSync({ config, rootDir: root, manifest }).passed).toBe(true);
    expect(read(root, CONSUMER)).toContain(PACKAGE);
  }, 120_000);

  test("refuses to compile wiring for a consumer the lockfile has no importer for", () => {
    const root = fixtureRepo(wiringFiles());
    const config = fixtureConfig(root);
    const context = new WorkspaceContext(config, root);
    const wiringInput = (lockfileText: string) => ({
      context,
      config,
      application: config.applications[0]!,
      packageManager: pnpmAdapter,
      taskRunner: createTaskRunnerAdapter(config),
      packageName: PACKAGE,
      packageRoot: PACKAGE_ROOT,
      projectId: "analytics",
      production: [] as string[],
      dependencies: { runtime: {}, dev: {}, packageReferences: [] },
      consumerOwners: [APP],
      lockfileText,
    });

    // The pair is the point. Against a lockfile that has the consumer's
    // importer, the wiring is emitted; against one that does not, the old code
    // emitted the manifest and tsconfig edits and *silently* dropped the
    // lockfile operation, so the plan declared a dependency nothing would
    // resolve and no proof anywhere could notice.
    const wired = consumerWiringOperations(wiringInput(WIRING_LOCKFILE));
    expect(wired.filter((operation) => operation.kind === "lockfile-importer")).toHaveLength(1);

    // `LOCKFILE` predates the application: it has `.` and `libs/zeta` only.
    expect(pnpmAdapter.importerBlock(LOCKFILE, APP)).toBeUndefined();
    expect(() => consumerWiringOperations(wiringInput(LOCKFILE))).toThrow(PlanningError);
    expect(() => consumerWiringOperations(wiringInput(LOCKFILE))).toThrow(`pnpm-lock.yaml has no importer entry for ${APP}`);
  });
});
