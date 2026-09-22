/**
 * Generated artifacts: the files an extraction invalidates without touching.
 *
 * The workspace this was found in has a codegen'd ledger keyed on a source
 * count and a workspace gate that checks it. Moving files made the ledger
 * stale, the gate failed, and no plan touching those files could ever be
 * applied — because `regenerate` was declared in config, validated by the
 * schema, recorded in the manifest, exempted by the audit, and executed
 * nowhere. Each test here is one link in that chain.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { rewriteResolvedImportSpecifier } from "../src/codemod/imports.ts";
import { triggeredArtifacts, type MonocarveUserConfig } from "../src/config.ts";
import { generatedFilesFor } from "../src/plan/build.ts";
import { WorkspaceContext } from "../src/plan/context.ts";
import type { ExtractionManifest, PlanOperation } from "../src/plan/manifest.ts";
import { assertPlanValid, validatePlan } from "../src/plan/validate.ts";
import { applyPlan } from "../src/transaction/apply.ts";
import { auditPlanSync } from "../src/transaction/audit.ts";
import { simulatePlan } from "../src/transaction/simulate.ts";
import { fileState } from "../src/util/files.ts";
import { hashText } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureConfig, fixtureGit, fixtureRepo, read, write } from "./support/fixture-repo.ts";

const DONOR = "apps/api/src/widget/widget.ts";
const TARGET = "libs/analytics/src/widget/widget.ts";
const CONSUMER = "apps/api/src/consumer.ts";
const ENTRYPOINT = "libs/analytics/src/index.ts";
const LEDGER = "generated/ledger.json";
const PACKAGE = "@acme/analytics";
const PACKAGE_ROOT = "libs/analytics";
const REGENERATE = "sh scripts/ledger.sh";

/** Two `.ts` files under `apps/api/src` at the baseline; one after the move. */
const BASELINE_LEDGER = '{ "sources": 2 }\n';
const EXTRACTED_LEDGER = '{ "sources": 1 }\n';

const LEDGER_SCRIPT = `#!/bin/sh
set -eu
output="\${1:-${LEDGER}}"
mkdir -p "$(dirname "$output")"
printf '{ "sources": %s }\\n' "$(find apps/api/src -name '*.ts' -type f | wc -l | tr -d ' \\n')" >"$output"
`;

const CHECK_SCRIPT = `#!/bin/sh
set -eu
expected="$(mktemp)"
trap 'rm -f "$expected"' EXIT
sh scripts/ledger.sh "$expected"
if ! diff -u ${LEDGER} "$expected" >/dev/null 2>&1; then
  echo "ledger is stale: it counts a tree that no longer exists" >&2
  exit 1
fi
`;

const BROKEN_SCRIPT = `#!/bin/sh
echo "generator exploded: missing input" >&2
exit 3
`;

function fixtureFiles(): Record<string, string> {
  return {
    "package.json": `${JSON.stringify({ name: "fixture-workspace", private: true, type: "module" }, null, 2)}\n`,
    "apps/api/tsconfig.json": `${JSON.stringify({ include: ["src"] }, null, 2)}\n`,
    [DONOR]: "export const widgetValue = 1;\n",
    [CONSUMER]: 'import { widgetValue } from "./widget/widget.ts";\n\nexport const used = widgetValue + 1;\n',
    [`${PACKAGE_ROOT}/package.json`]: `${JSON.stringify(
      {
        name: PACKAGE,
        version: "0.1.0",
        private: true,
        type: "module",
        main: "./src/index.ts",
        types: "./src/index.ts",
        exports: { ".": { types: "./src/index.ts", import: "./src/index.ts", default: "./src/index.ts" } },
      },
      null,
      2,
    )}\n`,
    [LEDGER]: BASELINE_LEDGER,
    "scripts/ledger.sh": LEDGER_SCRIPT,
    "scripts/check-ledger.sh": CHECK_SCRIPT,
    "scripts/broken-ledger.sh": BROKEN_SCRIPT,
  };
}

interface FixtureOptions {
  /** Regexes over moved paths. Defaults to one that matches the donor. */
  readonly triggers?: readonly string[];
  /** Command the artifact declares. */
  readonly regenerate?: string;
  /** Declare no artifact at all — the state this whole feature replaces. */
  readonly withoutArtifact?: boolean;
  /** Gate commands. Defaults to the ledger check, which is the point. */
  readonly gates?: readonly string[];
}

function configFor(root: string, options: FixtureOptions = {}) {
  const artifacts = options.withoutArtifact
    ? []
    : [{ path: LEDGER, source: "apps/api/src", regenerate: options.regenerate ?? REGENERATE, triggers: [...(options.triggers ?? ["^apps/api/src/widget/"])] }];
  const overrides: Partial<MonocarveUserConfig> = {
    generatedArtifacts: { artifacts },
    gates: { package: [], project: [], workspace: [...(options.gates ?? ["sh scripts/check-ledger.sh"])] },
  };
  return fixtureConfig(root, overrides);
}

/**
 * A plan that moves one module, repoints its one consumer, and writes the
 * barrel. `artifact` decides whether it also declares the ledger regeneration —
 * the single difference every test here turns on.
 */
function manifestFor(root: string, options: { artifact: boolean; regenerate?: string; gates?: readonly string[] } = { artifact: true }): ExtractionManifest {
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
    { kind: "write-file", path: ENTRYPOINT, contents: barrel, preconditionHash: "missing", resultHash: hashText(barrel), generator: "scaffold:entrypoint" },
  ];

  return {
    schemaVersion: 2,
    planId: "fixture-regeneration",
    createdAt: new Date().toISOString(),
    generator: { name: "monocarve", version: "0.0.0" },
    baselineCommit: fixtureGit(root, "rev-parse", "HEAD"),
    graphDigest: hashText("fixture-graph"),
    application: "api",
    target: { packageName: PACKAGE, packageRoot: PACKAGE_ROOT, entrypoint: "src/index.ts", requiredExports: [{ name: "widgetValue", typeOnly: false }] },
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
    generatedFiles: options.artifact
      ? [
          {
            path: LEDGER,
            source: "apps/api/src",
            regenerate: options.regenerate ?? REGENERATE,
            regenerateOnApply: true,
            exemptReason: "declared generated artifact: regenerated by the transaction",
          },
        ]
      : [],
    changedFiles: [DONOR, TARGET, CONSUMER, ENTRYPOINT, ...(options.artifact ? [LEDGER] : [])].sort(),
    expectedDynamicImportDelta: { added: [], removed: [] },
    evaluationEffects: [],
    metrics: { movedFiles: 1, movedLines: 1, applicationLinesBefore: 4, applicationLinesAfter: 3, consumers: 1 },
    commits: {
      plan: { subject: "chore(@acme/analytics): compile extraction plan fixture-regeneration" },
      move: { subject: "refactor(@acme/analytics): move 1 files into libs/analytics" },
      wiring: { subject: "refactor(@acme/analytics): wire @acme/analytics into the workspace" },
    },
    gates: { package: [], project: [], workspace: [...(options.gates ?? ["sh scripts/check-ledger.sh"])] },
  };
}

function landManifest(root: string, manifest: ExtractionManifest): string {
  const path = "plans/fixture-regeneration.json";
  write(root, path, `${JSON.stringify(manifest, null, 2)}\n`);
  fixtureGit(root, "add", "--", path);
  fixtureGit(root, "commit", "-qm", manifest.commits.plan!.subject);
  return path;
}

describe("generated artifacts are regenerated, not merely declared", () => {
  afterEach(cleanupFixtures);

  test("regenerates a triggered artifact in the simulation, before the gates read it", async () => {
    const root = fixtureRepo(fixtureFiles());
    const config = configFor(root);
    const manifest = manifestFor(root);
    // The gates the plan carries are the config's, and the ledger check is one
    // of them: this simulation passing *is* the proof that regeneration
    // happened first, because the check fails on a stale ledger.
    const result = await simulatePlan({ config, rootDir: root, manifest });

    expect(result.failure).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.regeneration?.ok).toBe(true);
    expect(result.regeneration?.artifacts).toHaveLength(1);
    const artifact = result.regeneration!.artifacts[0]!;
    expect(artifact.path).toBe(LEDGER);
    expect(artifact.command).toBe(REGENERATE);
    expect(artifact.exitCode).toBe(0);
    // The ledger counted two modules and now counts one: the extraction really
    // did invalidate it, so a passing run is not a vacuous one.
    expect(artifact.changed).toBe(true);
    expect(artifact.hash).toBe(hashText(EXTRACTED_LEDGER));
    expect(result.gates.every((gate) => gate.exitCode === 0)).toBe(true);
    expect(result.gates.map((gate) => gate.command)).toContain("sh scripts/check-ledger.sh");

    // And the developer's checkout is untouched, ledger included.
    expect(read(root, LEDGER)).toBe(BASELINE_LEDGER);
    expect(existsSync(join(root, DONOR))).toBe(true);
    expect(existsSync(join(root, TARGET))).toBe(false);
  }, 180_000);

  test("leaves an artifact alone when no moved path matches its triggers", async () => {
    const root = fixtureRepo(fixtureFiles());
    const config = configFor(root, { triggers: ["^apps/other/"], gates: ["true"] });

    // The trigger decision is the plan's, and it is the same predicate the
    // transaction uses — so an artifact that never attaches to the plan is one
    // the transaction never runs.
    expect(triggeredArtifacts(config, [DONOR])).toEqual([]);
    const context = new WorkspaceContext(config, root);
    expect(generatedFilesFor(config, context, [DONOR], [TARGET])).toEqual([]);

    const manifest = manifestFor(root, { artifact: false, gates: ["true"] });
    const result = await simulatePlan({ config, rootDir: root, manifest });

    expect(result.ok).toBe(true);
    expect(result.regeneration?.artifacts).toEqual([]);
    // Nothing ran, so the ledger in the worktree stayed the committed one; the
    // only observable here is the checkout, which is also untouched.
    expect(read(root, LEDGER)).toBe(BASELINE_LEDGER);
  }, 180_000);

  test("a failing regeneration aborts the simulation before the real checkout is touched", async () => {
    const root = fixtureRepo(fixtureFiles());
    const config = configFor(root, { regenerate: "sh scripts/broken-ledger.sh" });
    const manifest = manifestFor(root, { artifact: true, regenerate: "sh scripts/broken-ledger.sh" });
    const manifestPath = landManifest(root, manifest);
    const head = fixtureGit(root, "rev-parse", "HEAD");

    const result = await applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true });

    expect(result.ok).toBe(false);
    expect(result.failure).toContain("exit 3");
    // The generator's own words, not a summary of them.
    expect(result.failure).toContain("generator exploded: missing input");

    expect(existsSync(join(root, DONOR))).toBe(true);
    expect(existsSync(join(root, TARGET))).toBe(false);
    expect(existsSync(join(root, ENTRYPOINT))).toBe(false);
    expect(read(root, LEDGER)).toBe(BASELINE_LEDGER);
    expect(fixtureGit(root, "rev-parse", "HEAD")).toBe(head);
    expect(fixtureGit(root, "status", "--short")).toBe("");
  }, 180_000);

  test("a failing regeneration during apply rolls the checkout back", async () => {
    const root = fixtureRepo(fixtureFiles());
    const config = configFor(root, { regenerate: "sh scripts/broken-ledger.sh" });
    const manifest = manifestFor(root, { artifact: true, regenerate: "sh scripts/broken-ledger.sh" });
    const manifestPath = landManifest(root, manifest);
    const head = fixtureGit(root, "rev-parse", "HEAD");

    // `skipSimulation` puts the failure where the rollback path is: the journal
    // has already replayed in the real checkout when the generator dies.
    await expect(applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true, skipSimulation: true })).rejects.toThrow("rollback complete");

    expect(read(root, DONOR)).toBe("export const widgetValue = 1;\n");
    expect(existsSync(join(root, TARGET))).toBe(false);
    expect(existsSync(join(root, ENTRYPOINT))).toBe(false);
    expect(read(root, LEDGER)).toBe(BASELINE_LEDGER);
    expect(fixtureGit(root, "rev-parse", "HEAD")).toBe(head);
    expect(fixtureGit(root, "status", "--short")).toBe("");
  }, 180_000);

  test("the regenerated artifact lands in the wiring commit, and validation demands it in changedFiles", async () => {
    const root = fixtureRepo(fixtureFiles());
    const config = configFor(root);
    const manifest = manifestFor(root);

    expect(manifest.changedFiles).toContain(LEDGER);
    expect(() => assertPlanValid(manifest, { config, rootDir: root })).not.toThrow();

    // A plan that regenerates a file it does not declare is not describing what
    // its own apply does, and validation says so.
    const undeclared = { ...manifest, changedFiles: manifest.changedFiles.filter((path) => path !== LEDGER) };
    const issues = validatePlan(undeclared, { config, rootDir: root }).issues;
    expect(issues.some((issue) => issue.rule === "changed-files")).toBe(true);

    const manifestPath = landManifest(root, manifest);
    const result = await applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true });
    expect(result.failure).toBeUndefined();
    expect(result.ok).toBe(true);

    const wiring = fixtureGit(root, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).sort();
    expect(wiring).toEqual([CONSUMER, ENTRYPOINT, LEDGER].sort());
    expect(read(root, LEDGER)).toBe(EXTRACTED_LEDGER);
    expect(fixtureGit(root, "show", `HEAD:${LEDGER}`)).toContain('"sources": 1');
    // The move commit stays a pure rename: the ledger is content, not a rename.
    expect(fixtureGit(root, "show", "--name-status", "--find-renames=100%", "--format=", "HEAD~1")).toBe(`R100\t${DONOR}\t${TARGET}`);
  }, 180_000);

  test("a stale artifact fails the workspace gate, and the failure carries the gate's own output", async () => {
    const root = fixtureRepo(fixtureFiles());
    // The pre-fix world: the repository checks its ledger, and nothing in the
    // plan regenerates it. The extraction is correct and unappliable.
    const config = configFor(root, { withoutArtifact: true });
    const manifest = manifestFor(root, { artifact: false });
    const manifestPath = landManifest(root, manifest);

    const result = await applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true });

    expect(result.ok).toBe(false);
    expect(result.failure).toContain("gate failed (workspace): sh scripts/check-ledger.sh");
    // The diagnosis, which `applyPlan` used to discard: without it the operator
    // is told a command failed and nothing about why.
    expect(result.failure).toContain("ledger is stale");
    expect(fixtureGit(root, "status", "--short")).toBe("");
  }, 180_000);

  test("the audit refuses an artifact that went stale again after it was regenerated", async () => {
    const root = fixtureRepo(fixtureFiles());
    const config = configFor(root);
    const manifest = manifestFor(root);
    const manifestPath = landManifest(root, manifest);
    expect((await applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true })).ok).toBe(true);

    const produced = fileState(join(root, LEDGER));
    // Positive control: with the hash regeneration produced, the tree agrees.
    expect(auditPlanSync({ config, rootDir: root, manifest, regeneratedArtifacts: { [LEDGER]: produced } }).passed).toBe(true);

    // Something rewrote the artifact after the generator did — a hook, a second
    // generator, a hand edit. The exemption covers "unknowable at plan time",
    // not "unknowable at all", and the audit now says so.
    writeFileSync(join(root, LEDGER), '{ "sources": 99 }\n');
    const stale = auditPlanSync({ config, rootDir: root, manifest, regeneratedArtifacts: { [LEDGER]: produced } });
    expect(stale.passed).toBe(false);
    expect(stale.generatedArtifacts.failures).toEqual([`generated artifact was changed after it was regenerated: ${LEDGER}`]);

    // An audit with no regeneration evidence still checks what it can: the
    // artifact exists, so it passes rather than inventing a verdict.
    expect(auditPlanSync({ config, rootDir: root, manifest }).generatedArtifacts.passed).toBe(true);
  }, 180_000);

  test("refuses a plan compiled before the config declared the artifact", async () => {
    const root = fixtureRepo(fixtureFiles());
    // Config triggers the ledger; the plan predates it and declares nothing.
    // Applying would leave the ledger stale with `changedFiles` silent about it.
    const config = configFor(root, { gates: ["true"] });
    const manifest = manifestFor(root, { artifact: false, gates: ["true"] });

    const result = await simulatePlan({ config, rootDir: root, manifest });

    expect(result.ok).toBe(false);
    expect(result.failure).toContain(LEDGER);
    expect(result.failure).toContain("recompile the plan");
  }, 180_000);
});
