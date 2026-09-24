import { describe, expect, test } from "bun:test";

import {
  assertPreparationManifestValid,
  createPreparationManifest,
  serializePreparationManifest,
  validatePreparationManifest,
  type PreparationManifest,
  type PreparationManifestDraft,
} from "../src/prepare/index.ts";
import { hashJson, hashText } from "../src/util/hash.ts";

const DONOR = "apps/api/src/contracts.ts";
const TARGET = "libs/contracts/src/contract.ts";
const DECLARATION = "export interface Contract { readonly id: string; }";
const LOCAL_DECLARATION = "type Local = Contract;";
const DONOR_BEFORE = `/** Contract documentation. */\n${DECLARATION}\n${LOCAL_DECLARATION}\n`;
const DONOR_AFTER = 'export type { Contract } from "../../../libs/contracts/src/contract.ts";\n';
const TARGET_AFTER = `/** Contract documentation. */\n${DECLARATION}\n`;
const BASELINE_DATE = "2024-01-02T03:04:05.000Z";

function manifest(): PreparationManifest {
  const sourceHash = hashText(DONOR_BEFORE);
  const start = DONOR_BEFORE.indexOf(DECLARATION);
  const end = start + DECLARATION.length;
  const spanHash = hashText(DONOR_BEFORE.slice(start, end));
  const declarationId = hashJson({ sourcePath: DONOR, name: "Contract", kind: "interface", start, end, spanHash });
  const extractionStart = 0;
  const extractionEnd = end;
  const extractionHash = hashText(DONOR_BEFORE.slice(extractionStart, extractionEnd));
  const selectorId = hashJson({ declarationId, sourcePath: DONOR, sourceHash, extractionStart, extractionEnd, extractionHash });
  const groupId = hashJson({ sourcePath: DONOR, name: "Contract", declarationIds: [declarationId] });
  const group = {
    groupId,
    sourcePath: DONOR,
    name: "Contract",
    space: "type" as const,
    declarations: [
      {
        declarationId,
        sourcePath: DONOR,
        sourceHash,
        name: "Contract",
        kind: "interface" as const,
        space: "type" as const,
        originallyExported: true,
        span: { start, end, hash: spanHash },
        selectorId,
        extractionStart,
        extractionEnd,
        extractionHash,
      },
    ],
  };
  const targetStart = TARGET_AFTER.indexOf(DECLARATION);
  const targetEnd = targetStart + DECLARATION.length;
  const targetHash = hashText(TARGET_AFTER.slice(targetStart, targetEnd));
  const targetExtractionStart = 0;
  const targetExtractionEnd = targetEnd;
  const targetExtractionHash = hashText(TARGET_AFTER.slice(targetExtractionStart, targetExtractionEnd));
  const draft: PreparationManifestDraft = {
    schemaVersion: 1,
    createdAt: BASELINE_DATE,
    generator: { name: "test-tool", version: "1.0.0" },
    baseline: { commit: "0123456789abcdef0123456789abcdef01234567", committerDate: BASELINE_DATE, configDigest: hashText("test-config") },
    graphDigest: hashText("fresh-workspace-graph"),
    declarations: [group],
    operations: [
      {
        kind: "extract-type-declarations",
        donor: { path: DONOR, preconditionHash: sourceHash, preconditionMode: 0o644, resultHash: hashText(DONOR_AFTER), resultMode: 0o644 },
        target: { path: TARGET, preconditionHash: "missing", preconditionMode: "missing", resultHash: hashText(TARGET_AFTER), resultMode: 0o644 },
        moduleSpecifier: "../../../libs/contracts/src/contract.js",
        declarations: [group],
        targetImportProofs: [],
        targetImports: [],
        donorImports: [],
        reExportNames: ["Contract"],
        targetDeclarationProofs: [
          { selectorId, targetStart, targetEnd, targetHash, targetExtractionStart, targetExtractionEnd, targetExtractionHash, synthesizedExport: false },
        ],
        donorContents: DONOR_AFTER,
        targetContents: TARGET_AFTER,
      },
    ],
    compatibilityReexports: [
      { fromPath: DONOR, toPath: TARGET, moduleSpecifier: "../../../libs/contracts/src/contract.js", exports: [{ name: "Contract", typeOnly: true }] },
    ],
    changedFiles: [DONOR, TARGET].toSorted(),
    commits: { prepare: { subject: "refactor: prepare type contract seam" } },
    gates: { package: [], project: [], workspace: [] },
  };
  return createPreparationManifest(draft);
}

function reidentify(manifest: PreparationManifest, patch: Partial<PreparationManifestDraft>): PreparationManifest {
  const { planId: _planId, ...draft } = manifest;
  return createPreparationManifest({ ...draft, ...patch });
}

function privateGroup(sourceHash: string) {
  const start = DONOR_BEFORE.indexOf(LOCAL_DECLARATION);
  const end = start + LOCAL_DECLARATION.length;
  const spanHash = hashText(DONOR_BEFORE.slice(start, end));
  const declarationId = hashJson({ sourcePath: DONOR, name: "Local", kind: "type-alias", start, end, spanHash });
  const extractionHash = spanHash;
  const selectorId = hashJson({ declarationId, sourcePath: DONOR, sourceHash, extractionStart: start, extractionEnd: end, extractionHash });
  return {
    groupId: hashJson({ sourcePath: DONOR, name: "Local", declarationIds: [declarationId] }),
    sourcePath: DONOR,
    name: "Local",
    space: "type" as const,
    declarations: [
      {
        declarationId,
        selectorId,
        sourcePath: DONOR,
        sourceHash,
        name: "Local",
        kind: "type-alias" as const,
        space: "type" as const,
        originallyExported: false,
        span: { start, end, hash: spanHash },
        extractionStart: start,
        extractionEnd: end,
        extractionHash,
      },
    ],
  };
}

function targetImport(sourceHash: string) {
  return {
    moduleSpecifier: "../../shared.js",
    importedName: "Remote",
    localName: "Remote",
    kind: "named" as const,
    originallyTypeOnly: true,
    requiredAs: "type" as const,
    proofBaselineHash: sourceHash,
  };
}

function targetImportProof(sourceHash: string) {
  return {
    originalSpecifier: "./shared.js",
    targetSpecifier: "../../shared.js",
    resolvedSourcePath: "apps/api/src/shared.ts",
    importedName: "Remote",
    localName: "Remote",
    kind: "named" as const,
    originallyTypeOnly: true,
    requiredAs: "type" as const,
    proofBaselineHash: sourceHash,
  };
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).reverse()) result[key] = reverseKeys((value as Record<string, unknown>)[key]);
  return result;
}

describe("preparation manifest", () => {
  test("serializes and identifies the same logical draft deterministically", () => {
    const first = manifest();
    const reordered = reverseKeys(first) as PreparationManifest;

    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(first));
    expect(serializePreparationManifest(reordered)).toBe(serializePreparationManifest(first));
    expect(serializePreparationManifest(first)).toEndWith("}\n");
    expect(validatePreparationManifest(first)).toEqual({ ok: true, issues: [] });
  });

  test("refuses a plan id or replay output hash that does not describe its bytes", () => {
    const base = manifest();
    const wrongId = { ...base, planId: "prepare-not-derived" };
    expect(() => assertPreparationManifestValid(wrongId)).toThrow("deterministic manifest identity");

    const extract = base.operations[0]!;
    if (extract.kind !== "extract-type-declarations") throw new Error("fixture operation must extract types");
    const badHash = reidentify(base, { operations: [{ ...extract, target: { ...extract.target, resultHash: hashText("wrong output") } }] });
    expect(() => assertPreparationManifestValid(badHash)).toThrow("resultHash does not match replay contents");
  });

  test("refuses donor mode drift and inconsistent missing-mode evidence", () => {
    const base = manifest();
    const extract = base.operations[0]!;
    if (extract.kind !== "extract-type-declarations") throw new Error("fixture operation must extract types");
    const drift = reidentify(base, { operations: [{ ...extract, donor: { ...extract.donor, resultMode: 0o755 } }] });
    expect(validatePreparationManifest(drift).issues.map((issue) => issue.rule)).toContain("extract-mode");

    const inconsistent = reidentify(base, { operations: [{ ...extract, target: { ...extract.target, preconditionMode: 0o644 } }] });
    expect(validatePreparationManifest(inconsistent).issues.map((issue) => issue.rule)).toContain("extract-target-mode");

    const nonCanonical = reidentify(base, { operations: [{ ...extract, donor: { ...extract.donor, preconditionMode: 0o664, resultMode: 0o664 } }] });
    expect(validatePreparationManifest(nonCanonical).issues.map((issue) => issue.rule)).toContain("extract-donor-mode");
  });

  test("refuses stale donor state and stale declaration span evidence", () => {
    const base = manifest();
    const extract = base.operations[0]!;
    if (extract.kind !== "extract-type-declarations") throw new Error("fixture operation must extract types");

    const staleState = validatePreparationManifest(base, { currentFiles: { [DONOR]: hashText("changed"), [TARGET]: "missing" } });
    expect(staleState.issues.map((issue) => issue.rule)).toContain("stale-input");

    const staleSpan = validatePreparationManifest(base, { currentContents: { [DONOR]: DONOR_BEFORE.replace("Contract", "Changed") } });
    expect(staleSpan.issues.map((issue) => issue.rule)).toContain("stale-selector");
  });

  test("refuses a forged trivia-inclusive removal region", () => {
    const base = manifest();
    const extract = base.operations[0]!;
    if (extract.kind !== "extract-type-declarations") throw new Error("fixture operation must extract types");
    const declaration = extract.declarations[0]!.declarations[0]!;
    const extractionEnd = declaration.extractionEnd + 1;
    const extractionHash = hashText(DONOR_BEFORE.slice(declaration.extractionStart, extractionEnd));
    const forgedSelector = {
      ...declaration,
      extractionEnd,
      extractionHash,
      selectorId: hashJson({
        declarationId: declaration.declarationId,
        sourcePath: DONOR,
        sourceHash: declaration.sourceHash,
        extractionStart: declaration.extractionStart,
        extractionEnd,
        extractionHash,
      }),
    };
    const forgedGroup = { ...extract.declarations[0]!, declarations: [forgedSelector] };
    const forged = reidentify(base, { declarations: [forgedGroup], operations: [{ ...extract, declarations: [forgedGroup] }] });
    expect(validatePreparationManifest(forged, { currentContents: { [DONOR]: DONOR_BEFORE } }).issues.map((issue) => issue.rule)).toContain("stale-extraction");
  });

  test("refuses a forged rendered target declaration span", () => {
    const base = manifest();
    const extract = base.operations[0]!;
    if (extract.kind !== "extract-type-declarations") throw new Error("fixture operation must extract types");
    const proof = extract.targetDeclarationProofs[0]!;
    const targetEnd = proof.targetEnd + 1;
    const forged = reidentify(base, {
      operations: [
        { ...extract, targetDeclarationProofs: [{ ...proof, targetEnd, targetHash: hashText(extract.targetContents.slice(proof.targetStart, targetEnd)) }] },
      ],
    });
    expect(validatePreparationManifest(forged).issues.map((issue) => issue.rule)).toContain("target-declaration-proof");
  });

  test("refuses a synthesized-export claim for an originally exported declaration", () => {
    const base = manifest();
    const extract = base.operations[0]!;
    if (extract.kind !== "extract-type-declarations") throw new Error("fixture operation must extract types");
    const invalid = reidentify(base, {
      operations: [{ ...extract, targetDeclarationProofs: [{ ...extract.targetDeclarationProofs[0]!, synthesizedExport: true }] }],
    });
    expect(validatePreparationManifest(invalid).issues.map((issue) => issue.rule)).toContain("target-declaration-proof");
  });

  test("refuses a forged rendered target extraction region", () => {
    const base = manifest();
    const extract = base.operations[0]!;
    if (extract.kind !== "extract-type-declarations") throw new Error("fixture operation must extract types");
    const proof = extract.targetDeclarationProofs[0]!;
    const targetExtractionEnd = proof.targetExtractionEnd + 1;
    const invalid = reidentify(base, {
      operations: [
        {
          ...extract,
          targetDeclarationProofs: [
            { ...proof, targetExtractionEnd, targetExtractionHash: hashText(extract.targetContents.slice(proof.targetExtractionStart, targetExtractionEnd)) },
          ],
        },
      ],
    });
    expect(validatePreparationManifest(invalid).issues.map((issue) => issue.rule)).toContain("target-declaration-proof");
  });

  test("refuses a stale checker-proven import recipe", () => {
    const base = manifest();
    const extract = base.operations[0]!;
    if (extract.kind !== "extract-type-declarations") throw new Error("fixture operation must extract types");
    const invalid = reidentify(base, {
      operations: [
        {
          ...extract,
          targetImports: [
            {
              moduleSpecifier: "./remote.js",
              importedName: "Remote",
              localName: "Remote",
              kind: "named",
              originallyTypeOnly: true,
              requiredAs: "type",
              proofBaselineHash: hashText("stale donor"),
            },
          ],
        },
      ],
    });
    expect(validatePreparationManifest(invalid).issues.map((issue) => issue.rule)).toContain("replay-import");
  });

  test("requires exact relative import provenance coverage without duplicates or orphans", () => {
    const base = manifest();
    const extract = base.operations[0]!;
    if (extract.kind !== "extract-type-declarations") throw new Error("fixture operation must extract types");
    const imported = targetImport(extract.donor.preconditionHash);
    const proof = targetImportProof(extract.donor.preconditionHash);

    const missing = reidentify(base, { operations: [{ ...extract, targetImports: [imported], targetImportProofs: [] }] });
    expect(validatePreparationManifest(missing).issues.map((issue) => issue.rule)).toContain("target-import-proof");

    const duplicate = reidentify(base, { operations: [{ ...extract, targetImports: [imported], targetImportProofs: [proof, proof] }] });
    expect(validatePreparationManifest(duplicate).issues.map((issue) => issue.rule)).toContain("target-import-proof");

    const orphan = reidentify(base, { operations: [{ ...extract, targetImports: [], targetImportProofs: [proof] }] });
    expect(validatePreparationManifest(orphan).issues.map((issue) => issue.rule)).toContain("target-import-proof");
  });

  test("refuses absent, malformed, or rescan-mismatched graph evidence", () => {
    const base = manifest();
    const malformed = reidentify(base, { graphDigest: "not-a-hash" });
    expect(validatePreparationManifest(malformed).issues.map((issue) => issue.rule)).toContain("graph-digest");

    const { graphDigest: _graphDigest, ...withoutGraphDigest } = base;
    expect(validatePreparationManifest(withoutGraphDigest as PreparationManifest).issues.map((issue) => issue.rule)).toContain("graph-digest");

    const expected = hashText("different-fresh-workspace-graph");
    expect(validatePreparationManifest(base, { expectedGraphDigest: expected }).issues.map((issue) => issue.message)).toContain(
      "graphDigest does not match the expected fresh workspace graph",
    );
  });

  test("refuses ambiguous groups, non-type declarations, and compatibility not backed by its extraction", () => {
    const base = manifest();
    const extract = base.operations[0]!;
    if (extract.kind !== "extract-type-declarations") throw new Error("fixture operation must extract types");
    const selector = extract.declarations[0]!.declarations[0]!;
    const valueSelector = { ...selector, kind: "class" as const };
    const valueGroup = {
      ...extract.declarations[0]!,
      declarations: [valueSelector],
      groupId: hashJson({ sourcePath: DONOR, name: "Contract", declarationIds: [valueSelector.declarationId] }),
    };
    const ambiguous = reidentify(base, {
      declarations: [extract.declarations[0]!, valueGroup],
      operations: [{ ...extract, declarations: [extract.declarations[0]!, valueGroup] }],
      compatibilityReexports: [
        {
          fromPath: DONOR,
          toPath: "libs/other/src/contract.ts",
          moduleSpecifier: "../../../libs/other/src/contract.js",
          exports: [{ name: "Absent", typeOnly: true }],
        },
      ],
    });
    const rules = validatePreparationManifest(ambiguous).issues.map((issue) => issue.rule);
    expect(rules).toContain("declaration-group");
    expect(rules).toContain("declaration-kind");
    expect(rules).toContain("compatibility");
  });

  test("refuses changed scope that omits a replay mutation", () => {
    const base = manifest();
    const omitted = reidentify(base, { changedFiles: [DONOR] });
    expect(() => assertPreparationManifestValid(omitted)).toThrow("changedFiles must exactly equal");
  });

  test("refuses compatibility leakage of a private closure group", () => {
    const base = manifest();
    const extract = base.operations[0]!;
    if (extract.kind !== "extract-type-declarations") throw new Error("fixture operation must extract types");
    const privateSelector = { ...extract.declarations[0]!.declarations[0]!, name: "Local", originallyExported: false };
    const privateId = hashJson({
      sourcePath: DONOR,
      name: "Local",
      kind: privateSelector.kind,
      start: privateSelector.span.start,
      end: privateSelector.span.end,
      spanHash: privateSelector.span.hash,
    });
    const privateWithId = {
      ...privateSelector,
      declarationId: privateId,
      selectorId: hashJson({
        declarationId: privateId,
        sourcePath: DONOR,
        sourceHash: privateSelector.sourceHash,
        extractionStart: privateSelector.extractionStart,
        extractionEnd: privateSelector.extractionEnd,
        extractionHash: privateSelector.extractionHash,
      }),
    };
    const privateGroup = {
      ...extract.declarations[0]!,
      name: "Local",
      declarations: [privateWithId],
      groupId: hashJson({ sourcePath: DONOR, name: "Local", declarationIds: [privateId] }),
    };
    const leaked = reidentify(base, {
      declarations: [privateGroup],
      operations: [{ ...extract, declarations: [privateGroup] }],
      compatibilityReexports: [{ ...base.compatibilityReexports[0]!, exports: [{ name: "Local", typeOnly: true }] }],
    });
    expect(validatePreparationManifest(leaked).issues.map((issue) => issue.rule)).toContain("compatibility-exports");
  });

  test("accepts a public group with a private type-only closure excluded from compatibility", () => {
    const base = manifest();
    const extract = base.operations[0]!;
    if (extract.kind !== "extract-type-declarations") throw new Error("fixture operation must extract types");
    const privateClosure = privateGroup(extract.donor.preconditionHash);
    const targetContents = `${TARGET_AFTER}${LOCAL_DECLARATION}\n`;
    const privateTargetStart = targetContents.indexOf(LOCAL_DECLARATION);
    const privateTargetProof = {
      selectorId: privateClosure.declarations[0]!.selectorId,
      targetStart: privateTargetStart,
      targetEnd: privateTargetStart + LOCAL_DECLARATION.length,
      targetHash: hashText(LOCAL_DECLARATION),
      targetExtractionStart: privateTargetStart - 1,
      targetExtractionEnd: privateTargetStart + LOCAL_DECLARATION.length,
      targetExtractionHash: hashText(targetContents.slice(privateTargetStart - 1, privateTargetStart + LOCAL_DECLARATION.length)),
      synthesizedExport: false,
    };
    const combined = reidentify(base, {
      declarations: [extract.declarations[0]!, privateClosure],
      operations: [
        {
          ...extract,
          target: { ...extract.target, resultHash: hashText(targetContents) },
          targetContents,
          declarations: [extract.declarations[0]!, privateClosure],
          targetDeclarationProofs: [...extract.targetDeclarationProofs, privateTargetProof],
        },
      ],
    });
    expect(validatePreparationManifest(combined)).toEqual({ ok: true, issues: [] });
  });

  test("refuses overlapping trivia-inclusive extraction regions", () => {
    const base = manifest();
    const extract = base.operations[0]!;
    if (extract.kind !== "extract-type-declarations") throw new Error("fixture operation must extract types");
    const publicSelector = extract.declarations[0]!.declarations[0]!;
    const privateClosure = privateGroup(extract.donor.preconditionHash);
    const privateSelector = privateClosure.declarations[0]!;
    const extractionStart = publicSelector.extractionEnd - 1;
    const extractionHash = hashText(DONOR_BEFORE.slice(extractionStart, privateSelector.extractionEnd));
    const overlappingSelector = {
      ...privateSelector,
      extractionStart,
      extractionHash,
      selectorId: hashJson({
        declarationId: privateSelector.declarationId,
        sourcePath: DONOR,
        sourceHash: privateSelector.sourceHash,
        extractionStart,
        extractionEnd: privateSelector.extractionEnd,
        extractionHash,
      }),
    };
    const overlappingGroup = { ...privateClosure, declarations: [overlappingSelector] };
    const overlapping = reidentify(base, {
      declarations: [extract.declarations[0]!, overlappingGroup],
      operations: [{ ...extract, declarations: [extract.declarations[0]!, overlappingGroup] }],
    });
    expect(validatePreparationManifest(overlapping).issues.map((issue) => issue.rule)).toContain("extraction-region");
  });

  test("records an exact valid NodeNext specifier and refuses an ambiguous traversal", () => {
    const base = manifest();
    expect(base.compatibilityReexports[0]!.moduleSpecifier).toBe("../../../libs/contracts/src/contract.js");
    const invalid = reidentify(base, { compatibilityReexports: [{ ...base.compatibilityReexports[0]!, moduleSpecifier: "./target/../contract.js" }] });
    expect(validatePreparationManifest(invalid).issues.map((issue) => issue.rule)).toContain("compatibility-specifier");
  });
});
