import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync } from "node:fs";

import ts from "typescript";

import { parseConfig } from "../src/config.ts";
import { auditPreparationSync } from "../src/prepare/audit.ts";
import type { PreparationManifest } from "../src/prepare/manifest-types.ts";
import { hashJson, hashText } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureConfig, fixtureGit, fixtureRepo, write } from "./support/fixture-repo.ts";

const DONOR = "apps/api/src/contracts.ts";
const TARGET = "apps/api/src/contracts-types.ts";
const MANIFEST_PATH = "plans/prepare-fixture.json";
const EXTRACTED = "export interface Contract { id: string }";
const ORIGINAL = `${EXTRACTED}\nexport const runtime = 1;\n`;
const DONOR_AFTER = '\nexport const runtime = 1;\n\nexport type { Contract } from "./contracts-types.ts";\n';
const TARGET_AFTER = `${EXTRACTED}\n`;

describe("preparation audit", () => {
  afterEach(cleanupFixtures);

  test("replays byte-identical type extraction and its compatibility surface", () => {
    const root = preparedFixture();
    const report = auditPreparationSync({
      rootDir: root,
      config: existingConfig(root),
      manifest: manifest(root),
      approvedManifestPath: MANIFEST_PATH,
      freshGraph: { commit: fixtureGit(root, "rev-parse", "HEAD"), digest: hashText("fixture-graph") },
    });

    expect(report.passed).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.byteReplay.checked).toBeGreaterThan(0);
    expect(report.fileModes.passed).toBe(true);
    expect(report.selectorIntegrity.passed).toBe(true);
    expect(report.declarationOwnership.passed).toBe(true);
    expect(report.compatibilitySurface.passed).toBe(true);
    expect(report.targetImportResolution.passed).toBe(true);
    expect(report.changedPathScope.passed).toBe(true);
    expect(report.typeValueClaims.passed).toBe(true);
    expect(report.graphDigest.passed).toBe(true);
  });

  test("fails mode proof when matching preparation bytes become executable", () => {
    const root = preparedFixture();
    chmodSync(`${root}/${DONOR}`, 0o755);

    const report = auditPreparationSync({
      rootDir: root,
      config: existingConfig(root),
      manifest: manifest(root),
      approvedManifestPath: MANIFEST_PATH,
      freshGraph: { commit: fixtureGit(root, "rev-parse", "HEAD"), digest: hashText("fixture-graph") },
    });

    expect(report.byteReplay.passed).toBe(true);
    expect(report.fileModes.failures).toEqual([`landed mode differs: ${DONOR} (expected 420, got 493)`]);
  });

  test("fails each proof when target bytes, selector ownership, surface, or scope is false", () => {
    const root = preparedFixture();
    const base = manifest(root);
    write(root, TARGET, "export const Contract = 1;\n");
    write(root, "unrelated.ts", "export const unrelated = true;\n");
    const duplicate = base.declarations[0]!;
    const tampered: PreparationManifest = {
      ...base,
      declarations: [duplicate, duplicate],
      operations: base.operations.map((operation) =>
        operation.kind === "extract-type-declarations"
          ? {
              ...operation,
              declarations: [duplicate, duplicate],
              targetImportProofs: [
                {
                  originalSpecifier: "./contracts-types.ts",
                  targetSpecifier: "./rewritten-contracts.ts",
                  resolvedSourcePath: TARGET,
                  localName: "Contract",
                  importedName: "Contract",
                  kind: "named",
                  originallyTypeOnly: true,
                  requiredAs: "type",
                  proofBaselineHash: hashText(ORIGINAL),
                },
              ],
            }
          : operation,
      ),
      compatibilityReexports: [{ ...base.compatibilityReexports[0]!, exports: [{ name: "Contract", typeOnly: true }] }],
    };
    // This changes the compatibility surface without changing the declared
    // result hash. It cannot pass the byte check, and the separate type/value
    // proof must additionally reject the runtime export.
    write(root, DONOR, '\nexport const runtime = 1;\n\nexport { Contract } from "./contracts-types.ts";\n');

    const report = auditPreparationSync({
      rootDir: root,
      config: existingConfig(root),
      manifest: tampered,
      approvedManifestPath: MANIFEST_PATH,
      freshGraph: { commit: fixtureGit(root, "rev-parse", "HEAD"), digest: hashText("another-graph") },
    });

    expect(report.byteReplay.passed).toBe(false);
    expect(report.selectorIntegrity.failures.join("\n")).toContain("more than once");
    expect(report.declarationOwnership.failures.join("\n")).toContain("singular extraction ownership");
    expect(report.compatibilitySurface.failures.join("\n")).toContain("missing");
    expect(report.targetImportResolution.failures.join("\n")).toContain("target import proof names no donor import");
    expect(report.changedPathScope.failures).toContain("changed path is outside preparation scope: unrelated.ts");
    expect(report.typeValueClaims.failures.join("\n")).toContain("runtime statement");
    expect(report.typeValueClaims.failures.join("\n")).toContain("compatibility export resolves to a value symbol");
    expect(report.graphDigest.failures).toEqual(["manifest graph digest does not match the fresh graph evidence"]);
  });

  test("requires the exact recorded compatibility module specifier", () => {
    const root = preparedFixture();
    const base = manifest(root);
    const tampered: PreparationManifest = {
      ...base,
      compatibilityReexports: [{ ...base.compatibilityReexports[0]!, moduleSpecifier: "./other-contracts.ts" }],
    };

    const report = auditPreparationSync({
      rootDir: root,
      config: existingConfig(root),
      manifest: tampered,
      approvedManifestPath: MANIFEST_PATH,
      freshGraph: { commit: fixtureGit(root, "rev-parse", "HEAD"), digest: hashText("fixture-graph") },
    });

    expect(report.byteReplay.passed).toBe(true);
    expect(report.compatibilitySurface.failures).toContain("compatibility specifier differs from extraction replay: apps/api/src/contracts.ts");
  });

  test("resolves compatibility through the real workspace instead of trusting the claimed specifier", () => {
    const root = preparedFixture();
    const base = manifest(root);
    const wrongSpecifier = "./missing-contracts.ts";
    const wrongDonor = `\nexport const runtime = 1;\n\nexport type { Contract } from "${wrongSpecifier}";\n`;
    write(root, DONOR, wrongDonor);
    const tampered: PreparationManifest = {
      ...base,
      operations: base.operations.map((operation) =>
        operation.kind === "extract-type-declarations"
          ? { ...operation, donor: { ...operation.donor, resultHash: hashText(wrongDonor) }, moduleSpecifier: wrongSpecifier, donorContents: wrongDonor }
          : operation,
      ),
      compatibilityReexports: base.compatibilityReexports.map((intent) => ({ ...intent, moduleSpecifier: wrongSpecifier })),
    };

    const report = auditPreparationSync({
      rootDir: root,
      config: existingConfig(root),
      manifest: tampered,
      approvedManifestPath: MANIFEST_PATH,
      freshGraph: { commit: fixtureGit(root, "rev-parse", "HEAD"), digest: hashText("fixture-graph") },
    });

    expect(report.byteReplay.passed).toBe(true);
    expect(report.typeValueClaims.failures).toContain("compatibility export resolves to a different target symbol: apps/api/src/contracts.ts:Contract");
  });

  test("fails a type-only compatibility re-export that dangles after target tampering", () => {
    const root = preparedFixture();
    const base = manifest(root);
    write(root, TARGET, "export interface Other { id: string }\n");

    const report = auditPreparationSync({
      rootDir: root,
      config: existingConfig(root),
      manifest: base,
      approvedManifestPath: MANIFEST_PATH,
      freshGraph: { commit: fixtureGit(root, "rev-parse", "HEAD"), digest: hashText("fixture-graph") },
    });

    expect(report.compatibilitySurface.passed).toBe(true);
    expect(report.typeValueClaims.failures).toContain("compatibility export does not resolve from donor to target: apps/api/src/contracts.ts:Contract");
  });

  test("does not mistake a comment containing the selected bytes for target ownership", () => {
    const root = preparedFixture();
    const base = manifest(root);
    write(root, TARGET, `// ${EXTRACTED}\nexport interface Other { id: string }\n`);

    const report = auditPreparationSync({
      rootDir: root,
      config: existingConfig(root),
      manifest: base,
      approvedManifestPath: MANIFEST_PATH,
      freshGraph: { commit: fixtureGit(root, "rev-parse", "HEAD"), digest: hashText("fixture-graph") },
    });

    expect(report.declarationOwnership.failures).toContain("target does not own selected declaration exactly once: apps/api/src/contracts.ts:Contract");
    expect(report.declarationOwnership.failures).toContain(
      "target contains an unproven type declaration: apps/api/src/contracts-types.ts:InterfaceDeclaration",
    );
  });

  test("fails a forged target full-span proof that includes trailing bytes", () => {
    const root = preparedFixture();
    const base = manifest(root);
    const tampered: PreparationManifest = {
      ...base,
      operations: base.operations.map((operation) =>
        operation.kind === "extract-type-declarations"
          ? {
              ...operation,
              targetDeclarationProofs: operation.targetDeclarationProofs.map((proof) => ({
                ...proof,
                targetExtractionEnd: proof.targetExtractionEnd + 1,
                targetExtractionHash: hashText(`${EXTRACTED}\n`),
              })),
            }
          : operation,
      ),
    };

    const report = auditPreparationSync({
      rootDir: root,
      config: existingConfig(root),
      manifest: tampered,
      approvedManifestPath: MANIFEST_PATH,
      freshGraph: { commit: fixtureGit(root, "rev-parse", "HEAD"), digest: hashText("fixture-graph") },
    });

    expect(report.declarationOwnership.failures).toContain("target does not own selected declaration exactly once: apps/api/src/contracts.ts:Contract");
  });

  test("fails hash-consistent extra target imports that the recorded recipe never renders", () => {
    const root = preparedFixture();
    const base = manifest(root);
    const prefix = 'import type { Injected } from "@example/types";\n\n';
    const injectedTarget = `${prefix}${TARGET_AFTER}`;
    write(root, TARGET, injectedTarget);
    const tampered: PreparationManifest = {
      ...base,
      operations: base.operations.map((operation) =>
        operation.kind === "extract-type-declarations"
          ? {
              ...operation,
              target: { ...operation.target, resultHash: hashText(injectedTarget) },
              targetContents: injectedTarget,
              targetDeclarationProofs: operation.targetDeclarationProofs.map((proof) => ({
                ...proof,
                targetStart: proof.targetStart + prefix.length,
                targetEnd: proof.targetEnd + prefix.length,
                targetExtractionStart: proof.targetExtractionStart + prefix.length,
                targetExtractionEnd: proof.targetExtractionEnd + prefix.length,
              })),
            }
          : operation,
      ),
    };

    const report = auditPreparationSync({
      rootDir: root,
      config: existingConfig(root),
      manifest: tampered,
      approvedManifestPath: MANIFEST_PATH,
      freshGraph: { commit: fixtureGit(root, "rev-parse", "HEAD"), digest: hashText("fixture-graph") },
    });

    expect(report.byteReplay.passed).toBe(true);
    expect(report.renderedReplay.failures).toEqual([
      "replay does not reproduce target bytes: apps/api/src/contracts-types.ts",
      "replay does not reproduce target declaration proofs: apps/api/src/contracts-types.ts",
    ]);
  });

  test("accepts a public type with a private closure exported only by the target", () => {
    const root = privateClosureFixture();
    const plan = privateClosureManifest(root);
    const report = auditPreparationSync({
      rootDir: root,
      config: existingConfig(root),
      manifest: plan,
      approvedManifestPath: MANIFEST_PATH,
      freshGraph: { commit: fixtureGit(root, "rev-parse", "HEAD"), digest: hashText("private-graph") },
    });
    expect(report.failures).toEqual([]);
    expect(report.compatibilitySurface.passed).toBe(true);
    expect(report.declarationOwnership.passed).toBe(true);
  });
});

function preparedFixture(): string {
  const root = fixtureRepo({ "package.json": '{"name":"fixture","private":true}\n', "apps/api/tsconfig.json": '{"include":["src"]}\n', [DONOR]: ORIGINAL });
  fixtureConfig(root);
  write(root, DONOR, DONOR_AFTER);
  write(root, TARGET, TARGET_AFTER);
  chmodSync(`${root}/${DONOR}`, 0o644);
  chmodSync(`${root}/${TARGET}`, 0o644);
  write(root, MANIFEST_PATH, '{"plan":"provenance only"}\n');
  return root;
}

function manifest(root: string): PreparationManifest {
  const start = ORIGINAL.indexOf(EXTRACTED);
  const end = start + EXTRACTED.length;
  const sourceHash = hashText(ORIGINAL);
  const spanHash = hashText(EXTRACTED);
  const declarationId = hashJson({ sourcePath: DONOR, name: "Contract", kind: "interface", start, end, spanHash });
  const extractionHash = hashText(EXTRACTED);
  const selectorId = hashJson({ declarationId, sourcePath: DONOR, sourceHash, extractionStart: start, extractionEnd: end, extractionHash });
  const groupId = hashJson({ sourcePath: DONOR, name: "Contract", declarationIds: [declarationId] });
  const group = {
    groupId,
    sourcePath: DONOR,
    name: "Contract",
    space: "type" as const,
    declarations: [
      {
        declarationId,
        selectorId,
        sourcePath: DONOR,
        sourceHash,
        name: "Contract",
        kind: "interface" as const,
        space: "type" as const,
        originallyExported: true,
        span: { start, end, hash: spanHash },
        extractionStart: start,
        extractionEnd: end,
        extractionHash,
      },
    ],
  };
  return {
    schemaVersion: 1,
    planId: "prepare-fixture",
    createdAt: fixtureGit(root, "show", "-s", "--format=%cI", "HEAD"),
    generator: { name: "test", version: "1" },
    graphDigest: hashText("fixture-graph"),
    baseline: {
      commit: fixtureGit(root, "rev-parse", "HEAD"),
      committerDate: fixtureGit(root, "show", "-s", "--format=%cI", "HEAD"),
      configDigest: hashText("fixture-config"),
    },
    declarations: [group],
    operations: [
      {
        kind: "extract-type-declarations",
        donor: { path: DONOR, preconditionHash: sourceHash, preconditionMode: 0o644, resultHash: hashText(DONOR_AFTER), resultMode: 0o644 },
        target: { path: TARGET, preconditionHash: "missing", preconditionMode: "missing", resultHash: hashText(TARGET_AFTER), resultMode: 0o644 },
        moduleSpecifier: "./contracts-types.ts",
        declarations: [group],
        targetImportProofs: [],
        targetImports: [],
        donorImports: [],
        reExportNames: ["Contract"],
        targetDeclarationProofs: [
          {
            selectorId,
            targetStart: 0,
            targetEnd: EXTRACTED.length,
            targetHash: hashText(EXTRACTED),
            targetExtractionStart: 0,
            targetExtractionEnd: EXTRACTED.length,
            targetExtractionHash: hashText(EXTRACTED),
            synthesizedExport: false,
          },
        ],
        donorContents: DONOR_AFTER,
        targetContents: TARGET_AFTER,
      },
    ],
    compatibilityReexports: [{ fromPath: DONOR, toPath: TARGET, moduleSpecifier: "./contracts-types.ts", exports: [{ name: "Contract", typeOnly: true }] }],
    changedFiles: [DONOR, TARGET],
    commits: { prepare: { subject: "refactor: prepare contracts" } },
    gates: { package: [], project: [], workspace: [] },
  };
}

function privateClosureFixture(): string {
  const root = fixtureRepo({
    "package.json": '{"name":"fixture","private":true}\n',
    "apps/api/tsconfig.json": '{"include":["src"]}\n',
    [DONOR]: PRIVATE_ORIGINAL,
  });
  fixtureConfig(root);
  write(root, DONOR, '\n\nexport type { Public } from "./contracts-types.ts";\n');
  write(root, TARGET, PRIVATE_TARGET);
  chmodSync(`${root}/${DONOR}`, 0o644);
  chmodSync(`${root}/${TARGET}`, 0o644);
  write(root, MANIFEST_PATH, '{"plan":"private-provenance"}\n');
  return root;
}

const PRIVATE_ORIGINAL = "export interface Public { local: Local }\ninterface Local { id: string }\n";
const PRIVATE_TARGET = "export interface Public { local: Local }\n\nexport interface Local { id: string }\n";

function privateClosureManifest(root: string): PreparationManifest {
  const original = ts.createSourceFile(DONOR, PRIVATE_ORIGINAL, ts.ScriptTarget.Latest, true);
  const target = ts.createSourceFile(TARGET, PRIVATE_TARGET, ts.ScriptTarget.Latest, true);
  const sourceHash = hashText(PRIVATE_ORIGINAL);
  const selectors = original.statements.map((statement, index) => makeSelector(statement, index === 0, sourceHash, original));
  const targetProofs = target.statements
    .map((statement, index) => ({
      selectorId: selectors[index]!.selectorId,
      targetStart: statement.getStart(target),
      targetEnd: statement.end,
      targetHash: hashText(target.text.slice(statement.getStart(target), statement.end)),
      targetExtractionStart: statement.getFullStart(),
      targetExtractionEnd: statement.end,
      targetExtractionHash: hashText(target.text.slice(statement.getFullStart(), statement.end)),
      synthesizedExport: index === 1,
    }))
    .toSorted((left, right) => (left.selectorId < right.selectorId ? -1 : left.selectorId > right.selectorId ? 1 : 0));
  const groups = selectors.map((selector) => ({
    groupId: hashJson({ sourcePath: DONOR, name: selector.name, declarationIds: [selector.declarationId] }),
    sourcePath: DONOR,
    name: selector.name,
    space: "type" as const,
    declarations: [selector],
  }));
  return {
    ...manifest(root),
    graphDigest: hashText("private-graph"),
    declarations: groups,
    operations: [
      {
        kind: "extract-type-declarations",
        donor: { path: DONOR, preconditionHash: sourceHash, preconditionMode: 0o644, resultHash: hashText(readPrivateDonor()), resultMode: 0o644 },
        target: { path: TARGET, preconditionHash: "missing", preconditionMode: "missing", resultHash: hashText(PRIVATE_TARGET), resultMode: 0o644 },
        moduleSpecifier: "./contracts-types.ts",
        declarations: groups,
        targetImportProofs: [],
        targetImports: [],
        donorImports: [],
        reExportNames: ["Public"],
        targetDeclarationProofs: targetProofs,
        donorContents: readPrivateDonor(),
        targetContents: PRIVATE_TARGET,
      },
    ],
    compatibilityReexports: [{ fromPath: DONOR, toPath: TARGET, moduleSpecifier: "./contracts-types.ts", exports: [{ name: "Public", typeOnly: true }] }],
    changedFiles: [DONOR, TARGET],
  };
}

function makeSelector(statement: ts.Statement, originallyExported: boolean, sourceHash: string, source: ts.SourceFile) {
  const kind = ts.isInterfaceDeclaration(statement) ? ("interface" as const) : ("type-alias" as const);
  const name = (statement as ts.InterfaceDeclaration | ts.TypeAliasDeclaration).name.text;
  const start = statement.getStart(source);
  const end = statement.end;
  const spanHash = hashText(source.text.slice(start, end));
  const declarationId = hashJson({ sourcePath: DONOR, name, kind, start, end, spanHash });
  const extractionStart = statement.getFullStart();
  const extractionHash = hashText(source.text.slice(extractionStart, end));
  return {
    declarationId,
    selectorId: hashJson({ declarationId, sourcePath: DONOR, sourceHash, extractionStart, extractionEnd: end, extractionHash }),
    sourcePath: DONOR,
    sourceHash,
    name,
    kind,
    space: "type" as const,
    originallyExported,
    span: { start, end, hash: spanHash },
    extractionStart,
    extractionEnd: end,
    extractionHash,
  };
}

function readPrivateDonor(): string {
  return '\n\nexport type { Public } from "./contracts-types.ts";\n';
}

function existingConfig(root: string) {
  return parseConfig(JSON.parse(readFileSync(`${root}/monocarve.config.json`, "utf8")), "monocarve.config.json");
}
