/** Audit proof-negative cases. */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtractionManifest } from "../src/plan/manifest.ts";
import { assertPlanValid } from "../src/plan/validate.ts";
import { auditPlanSync } from "../src/transaction/audit.ts";
import { hashText } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureConfig, fixtureRepo, read, write } from "./support/fixture-repo.ts";
import { CONSUMER, DONOR, ENTRYPOINT, PACKAGE, PACKAGE_ROOT, TARGET, baseManifest, extractionFiles, landOnDisk } from "./support/transaction-fixture.ts";

describe("audit negative cases", () => {
  afterEach(cleanupFixtures);

  test("fails when a consumer still resolves into a moved source path", () => {
    const root = fixtureRepo(extractionFiles());
    const config = fixtureConfig(root);
    const manifest = baseManifest(root);
    const stale: ExtractionManifest = {
      ...manifest,
      consumers: [],
      changedFiles: manifest.changedFiles.filter((path) => path !== CONSUMER),
      operations: manifest.operations.filter((operation) => operation.kind !== "rewrite-import"),
    };
    landOnDisk(root, stale);

    const report = auditPlanSync({ config, rootDir: root, manifest: stale });
    expect(report.passed).toBe(false);
    expect(report.consumerCompleteness.failures.some((failure) => failure.includes("old-path consumer remains"))).toBe(true);
    expect(report.graphEvidence.movedPathEdges).toContain(`${CONSUMER} -> ./widget/widget.ts`);
  }, 60_000);

  test("fails when the declared lockfile importer block does not match the worktree", () => {
    const root = fixtureRepo(extractionFiles());
    const config = fixtureConfig(root);
    const manifest = baseManifest(root);
    landOnDisk(root, manifest);
    const tampered: ExtractionManifest = {
      ...manifest,
      operations: manifest.operations.map((operation) =>
        operation.kind === "lockfile-importer"
          ? { ...operation, block: operation.block.replace(`${PACKAGE_ROOT}: {}`, `${PACKAGE_ROOT}: {} # drift`) }
          : operation,
      ),
    };
    // A `replace` that matched nothing would leave the manifest untampered and
    // make the failure below unobtainable, so the tampering is asserted first.
    expect(tampered.operations).not.toEqual(manifest.operations);
    const report = auditPlanSync({ config, rootDir: root, manifest: tampered });
    expect(report.passed).toBe(false);
    expect(report.lockfileIntegrity.failures.some((failure) => failure.startsWith("lockfile importer block does not match the worktree"))).toBe(true);
  }, 60_000);

  test("fails when the package entrypoint is missing", () => {
    const root = fixtureRepo(extractionFiles());
    const config = fixtureConfig(root);
    const manifest = baseManifest(root);
    landOnDisk(root, manifest);
    rmSync(join(root, ENTRYPOINT));

    const report = auditPlanSync({ config, rootDir: root, manifest });
    expect(report.boundaryRules.passed).toBe(false);
    expect(report.boundaryRules.failures.join(" ")).toContain("target entrypoint does not exist");
  }, 60_000);

  test("fails when a moved module is orphaned from an unmoved asset", () => {
    const files = extractionFiles();
    files[DONOR] = 'import styles from "./widget.css";\n\nexport const widgetValue = styles ? 1 : 0;\n';
    files["apps/api/src/widget/widget.css"] = ".widget { color: red; }\n";
    files["apps/api/src/widget/widget.css.d.ts"] = "declare const styles: string;\nexport default styles;\n";

    const root = fixtureRepo(files);
    const config = fixtureConfig(root);
    const manifest = baseManifest(root);
    landOnDisk(root, manifest);

    const report = auditPlanSync({ config, rootDir: root, manifest });
    expect(report.passed).toBe(false);
    expect(report.graphEvidence.movedPathEdges).toContain(`${TARGET} -> ./widget.css (unresolved)`);
  }, 60_000);

  test("fails when a scaffolded write-file's landed bytes were edited after apply", () => {
    // The file the plan literally spells out, edited afterwards. Not the barrel:
    // a tsconfig has no re-export set, so proof 6 cannot see it, it is not a
    // move so proof 1's move loop cannot see it, and it is not in
    // `generatedFiles` so proof 7 cannot see it. Only comparing the landed bytes
    // against the operation's own `resultHash` notices.
    const root = fixtureRepo(extractionFiles());
    const config = fixtureConfig(root);
    const base = baseManifest(root);
    const scaffolded = `${PACKAGE_ROOT}/tsconfig.json`;
    const tsconfig = `${JSON.stringify({ include: ["src"], references: [] }, null, 2)}\n`;
    const manifest: ExtractionManifest = {
      ...base,
      changedFiles: [...base.changedFiles, scaffolded].toSorted(),
      operations: [
        ...base.operations,
        {
          kind: "write-file",
          path: scaffolded,
          contents: tsconfig,
          preconditionHash: "missing",
          resultHash: hashText(tsconfig),
          generator: "scaffold:tsconfig",
        },
      ],
    };
    expect(() => assertPlanValid(manifest, { config, rootDir: root })).not.toThrow();
    landOnDisk(root, manifest);
    // The same check must pass on the tree the plan left, or it would be
    // satisfied by always failing.
    expect(auditPlanSync({ config, rootDir: root, manifest }).passed).toBe(true);

    const tampered = `${JSON.stringify({ include: ["src", "../../apps/api/src"], references: [] }, null, 2)}\n`;
    write(root, scaffolded, tampered);

    const report = auditPlanSync({ config, rootDir: root, manifest });
    expect(report.byteFidelity.passed).toBe(false);
    expect(report.byteFidelity.failures).toEqual([
      `written file does not match its declared result: ${scaffolded} (expected ${hashText(tsconfig)}, got ${hashText(tampered)})`,
    ]);
    // Nothing else notices, which is why this check is not documentation.
    expect(report.failures).toEqual(report.byteFidelity.failures);
    expect(report.passed).toBe(false);
  }, 60_000);

  test("fails when the landed entrypoint evaluates a module the plan never declared", () => {
    // The barrel the *plan itself* declares reaches one module more than the
    // plan's own `source.files` account for. Proof 1 compares the landed bytes
    // against the operation, so it is satisfied by construction here, and a
    // `move` is byte-identical, so no content proof objects either. Only the
    // closure check notices, because it derives what it expects from
    // `source.files` rather than from the write-file operation. A consumer
    // repointed at the package name evaluates that module on import, and
    // `evaluationEffects` never looked at it.
    const root = fixtureRepo(extractionFiles());
    const config = fixtureConfig(root);
    const base = baseManifest(root);
    const stowaway = `${PACKAGE_ROOT}/src/widget/stowaway.ts`;
    const barrel = 'export * from "./widget/widget.ts";\nexport * from "./widget/stowaway.ts";\n';
    const manifest: ExtractionManifest = {
      ...base,
      operations: base.operations.map((operation) =>
        operation.kind === "write-file" && operation.path === ENTRYPOINT ? { ...operation, contents: barrel, resultHash: hashText(barrel) } : operation,
      ),
    };
    write(root, stowaway, "export const stowaway = Date.now();\n");
    landOnDisk(root, manifest);
    expect(read(root, ENTRYPOINT)).toBe(barrel);

    const report = auditPlanSync({ config, rootDir: root, manifest });
    expect(report.byteFidelity.passed).toBe(true);
    expect(report.entrypointClosure.passed).toBe(false);
    expect(report.entrypointClosure.failures).toEqual(["package entrypoint evaluates a module the plan never declared: widget/stowaway"]);
    // Nothing else notices, which is why this proof is not documentation.
    expect(report.failures).toEqual(report.entrypointClosure.failures);
    expect(report.passed).toBe(false);
  }, 60_000);

  test("fails when the declared evaluation effects name a path the plan does not produce", () => {
    const root = fixtureRepo(extractionFiles());
    const config = fixtureConfig(root);
    const base = baseManifest(root);
    landOnDisk(root, base);

    // The mistake this catches is inventorying the donor rather than the target:
    // the paths would all exist, all be plausible, and describe a file the
    // package does not contain.
    const sourcePaths: ExtractionManifest = {
      ...base,
      evaluationEffects: [{ subject: "module", reach: "moved", path: DONOR, kinds: ["expression-statement"] }],
    };
    const report = auditPlanSync({ config, rootDir: root, manifest: sourcePaths });
    expect(report.entrypointClosure.failures).toEqual([`declared evaluation effects name a path this plan does not produce: ${DONOR}`]);
    expect(report.passed).toBe(false);

    // The same inventory keyed to the target passes, so the failure above is
    // about the path and not about declaring effects at all.
    const targetPaths: ExtractionManifest = {
      ...base,
      evaluationEffects: [{ subject: "module", reach: "moved", path: TARGET, kinds: ["expression-statement"] }],
    };
    expect(auditPlanSync({ config, rootDir: root, manifest: targetPaths }).passed).toBe(true);
  }, 60_000);

  test("fails the move-with-rewrite replay proof when a landed byte is tampered", () => {
    const files = extractionFiles();
    files[DONOR] = 'import { helper } from "../shared/helper.ts";\n\nexport const widgetValue = helper;\n';
    files["apps/api/src/shared/helper.ts"] = "export const helper = 1;\n";

    const root = fixtureRepo(files);
    const config = fixtureConfig(root);
    const base = baseManifest(root);
    const rewrites = [{ donorlessSpecifier: "../shared/helper.ts", packageSpecifier: PACKAGE }];
    const rewritten = files[DONOR]!.replace("../shared/helper.ts", PACKAGE);
    const manifest: ExtractionManifest = {
      ...base,
      operations: base.operations.map((operation) =>
        operation.kind === "move"
          ? {
              kind: "move-with-rewrite",
              source: DONOR,
              target: TARGET,
              rewrites,
              preconditionHash: operation.preconditionHash,
              resultHash: hashText(rewritten),
            }
          : operation,
      ),
    };
    landOnDisk(root, manifest);
    expect(read(root, TARGET)).toBe(rewritten);
    expect(auditPlanSync({ config, rootDir: root, manifest }).codemodReplay.passed).toBe(true);

    writeFileSync(join(root, TARGET), rewritten.replace("widgetValue = helper", "widgetValue  = helper"));
    const report = auditPlanSync({ config, rootDir: root, manifest });
    expect(report.codemodReplay.passed).toBe(false);
    expect(report.codemodReplay.failures.join(" ")).toContain("replay proof does not reproduce the landed file");
  }, 60_000);
});
