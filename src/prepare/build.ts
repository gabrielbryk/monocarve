/** Compile a deterministic, replayable type-only preparation manifest. */
import { GENERATOR } from "../branding.ts";
import { configDigest, assertPreparationPolicyMatches, type MonocarveConfig } from "../config.ts";
import { PlanningError } from "../plan/context.ts";
import type { SeamPlan } from "../seams/types.ts";
import { resolveCommit, showBaseline } from "../util/git.ts";
import { byCodeUnit, hashJson, hashText, MISSING, type Sha256 } from "../util/hash.ts";
import { workspacePath } from "../util/paths.ts";
import { baselineFileMode, type PreparationManifestRendering } from "./build-shared.ts";
import { preparationCompilerOptions } from "./compiler-policy.ts";
import type {
  PreparationDeclarationSelector,
  PreparationDeclarationGroupSelector,
  PreparationManifest,
  PreparationInlineImportTypeProof,
  PreparationTargetImportProof,
} from "./manifest-types.ts";
import { createPreparationManifest, assertPreparationManifestValid } from "./manifest.ts";
import { renderTypeOnlyExtraction } from "./replay.ts";
import { selectTypeOnlyDeclarations } from "./selectors.ts";

interface RelativeTypeImportRewrite {
  readonly targetSpecifier: string;
  readonly resolvedSourcePath: string;
}

export interface CompilePreparationManifestInput {
  readonly rootDir: string;
  readonly config: MonocarveConfig;
  /** A revision, resolved atomically to the manifest baseline. */
  readonly baselineCommit: string;
  /** Digest of the fresh workspace graph that produced the reviewed seam. */
  readonly graphDigest: Sha256;
  /** The reviewed read-only partition whose moved groups become this preparation. */
  readonly seam: SeamPlan;
  /** Explicit destination file; affinity labels must never manufacture one. */
  readonly targetPath: string;
  /** Explicit import specifier from the donor to the destination module. */
  readonly targetModuleSpecifier: string;
  /** Exact operator-reviewed group identities; dependencies are derived, never guessed. */
  readonly reviewedGroupIds: readonly Sha256[];
  /** Config/checker-owned proof for each donor-relative import that moves to the target. */
  readonly rewriteRelativeTypeImport?: (input: {
    readonly donorPath: string;
    readonly targetPath: string;
    readonly originalSpecifier: string;
    readonly baselineCommit: string;
  }) => RelativeTypeImportRewrite;
  /** Config/caller-owned rendered values, recorded verbatim in the manifest. */
  readonly rendering: PreparationManifestRendering;
}

/**
 * Compile one preparation manifest from an explicit seam and selection.
 *
 * This reads the donor from the resolved baseline, never the working tree, so
 * every source span and precondition describes the same immutable revision.
 */
export function compilePreparationManifest(input: CompilePreparationManifestInput): PreparationManifest {
  workspacePath(input.rootDir, input.seam.sourcePath);
  workspacePath(input.rootDir, input.targetPath);
  if (input.targetPath === input.seam.sourcePath) throw new PlanningError("preparation target path must differ from the donor source path");
  if (input.targetModuleSpecifier.length === 0) throw new PlanningError("preparation requires an explicit non-empty target module specifier");
  if (/\{[A-Za-z][A-Za-z0-9_]*\}/.test(input.rendering.commit.subject)) {
    throw new PlanningError("preparation commit subject must be rendered; {planId} and other placeholders are not allowed");
  }
  assertPreparationPolicyMatches(
    input.config,
    { sourcePath: input.seam.sourcePath, targetPath: input.targetPath, targetModuleSpecifier: input.targetModuleSpecifier },
    input.rendering,
  );
  const reviewed = [...new Set(input.reviewedGroupIds)].toSorted(byCodeUnit);
  if (reviewed.length === 0 || reviewed.length !== input.reviewedGroupIds.length) {
    throw new PlanningError("preparation requires a non-empty, duplicate-free reviewed symbol selection");
  }
  const proposed = input.seam.movedGroups.map((group) => group.id).toSorted(byCodeUnit);
  if (reviewed.length !== proposed.length || reviewed.some((id, index) => id !== proposed[index])) {
    throw new PlanningError("reviewed symbol selection must exactly match the seam's moved declaration groups");
  }
  if (input.seam.targetPath !== undefined && input.seam.targetPath !== input.targetPath) {
    throw new PlanningError("explicit preparation target path must match the reviewed seam proposal");
  }
  if (input.seam.eligibleForTypeOnlyPreparation !== true) {
    throw new PlanningError("reviewed seam is not eligible for type-only preparation");
  }
  if (input.seam.requiredImports.some((item) => item.space !== "type")) {
    throw new PlanningError("type-only preparation refuses a seam with a value-space boundary dependency");
  }
  const baseline = resolveCommit(input.rootDir, input.baselineCommit);
  const donorMode = baselineFileMode(input.rootDir, baseline.commit, input.seam.sourcePath);
  const sourceText = showBaseline(input.rootDir, baseline.commit, input.seam.sourcePath);
  if (sourceText === null) throw new PlanningError(`preparation donor is absent from baseline: ${input.seam.sourcePath}`);
  if (showBaseline(input.rootDir, baseline.commit, input.targetPath) !== null) {
    throw new PlanningError(`preparation target already exists at baseline: ${input.targetPath}`);
  }
  if (hashText(sourceText) !== input.seam.sourceHash) throw new PlanningError("seam source hash does not match the resolved baseline donor");
  const selection = selectTypeOnlyDeclarations({
    sourcePath: input.seam.sourcePath,
    sourceText,
    groupIds: reviewed,
    compilerOptions: preparationCompilerOptions(input.rootDir, input.config, input.seam.sourcePath),
  });
  const closure = selection.closureGroupIds;
  if (reviewed.length !== closure.length || reviewed.some((id, index) => id !== closure[index])) {
    throw new PlanningError("type dependency closure expands beyond the operator-reviewed seam; review the expanded declaration groups before compiling");
  }
  type MutableGroup = Omit<PreparationDeclarationGroupSelector, "declarations"> & { declarations: PreparationDeclarationSelector[] };
  const declarations = selection.declarations.reduce<Map<Sha256, MutableGroup>>((groups, declaration) => {
    const current = groups.get(declaration.groupId) ?? {
      groupId: declaration.groupId,
      sourcePath: selection.sourcePath,
      name: declaration.name,
      space: "type" as const,
      declarations: [],
    };
    current.declarations.push({
      declarationId: hashJson({
        sourcePath: selection.sourcePath,
        name: declaration.name,
        kind: declaration.kind,
        start: declaration.declaration.start,
        end: declaration.declaration.end,
        spanHash: declaration.declaration.hash,
      }),
      sourcePath: selection.sourcePath,
      sourceHash: selection.sourceHash,
      name: declaration.name,
      kind: declaration.kind,
      space: "type",
      originallyExported: declaration.originallyExported,
      span: declaration.declaration,
      selectorId: hashJson({
        declarationId: hashJson({
          sourcePath: selection.sourcePath,
          name: declaration.name,
          kind: declaration.kind,
          start: declaration.declaration.start,
          end: declaration.declaration.end,
          spanHash: declaration.declaration.hash,
        }),
        sourcePath: selection.sourcePath,
        sourceHash: selection.sourceHash,
        extractionStart: declaration.extraction.start,
        extractionEnd: declaration.extraction.end,
        extractionHash: declaration.extraction.hash,
      }),
      extractionStart: declaration.extraction.start,
      extractionEnd: declaration.extraction.end,
      extractionHash: declaration.extraction.hash,
    });
    groups.set(declaration.groupId, current);
    return groups;
  }, new Map());
  const groups: PreparationDeclarationGroupSelector[] = [...declarations.values()]
    .map((group) => ({
      ...group,
      declarations: [...group.declarations].toSorted(
        (left, right) => left.span.start - right.span.start || byCodeUnit(left.declarationId, right.declarationId),
      ),
    }))
    .toSorted((left, right) => left.declarations[0]!.span.start - right.declarations[0]!.span.start || byCodeUnit(left.groupId, right.groupId));
  const targetImportProofs = new Map<string, PreparationTargetImportProof>();
  const rewriteRelative = (originalSpecifier: string): RelativeTypeImportRewrite => {
    const rewrite = input.rewriteRelativeTypeImport?.({
      donorPath: selection.sourcePath,
      targetPath: input.targetPath,
      originalSpecifier,
      baselineCommit: baseline.commit,
    });
    if (!rewrite) throw new PlanningError(`relative type import requires a configured rewrite proof: ${originalSpecifier}`);
    workspacePath(input.rootDir, rewrite.resolvedSourcePath);
    if (showBaseline(input.rootDir, baseline.commit, rewrite.resolvedSourcePath) === null)
      throw new PlanningError(`relative type import proof resolves no baseline source: ${rewrite.resolvedSourcePath}`);
    if (!rewrite.targetSpecifier.startsWith("."))
      throw new PlanningError(`relative type import proof must produce a relative target specifier for ${originalSpecifier}`);
    return rewrite;
  };
  const targetImports = selection.imports
    .map((item) => {
      if (!item.moduleSpecifier.startsWith(".")) return { ...item, proofBaselineHash: selection.sourceHash };
      const rewrite = rewriteRelative(item.moduleSpecifier);
      const proof = {
        originalSpecifier: item.moduleSpecifier,
        targetSpecifier: rewrite.targetSpecifier,
        resolvedSourcePath: rewrite.resolvedSourcePath,
        localName: item.localName,
        importedName: item.importedName,
        kind: item.kind,
        originallyTypeOnly: item.originallyTypeOnly,
        requiredAs: item.requiredAs,
        proofBaselineHash: selection.sourceHash,
      };
      targetImportProofs.set(`${proof.originalSpecifier}\0${proof.targetSpecifier}\0${proof.localName}\0${proof.importedName}\0${proof.kind}`, proof);
      return { ...item, moduleSpecifier: rewrite.targetSpecifier, proofBaselineHash: selection.sourceHash };
    })
    .toSorted(
      (left, right) =>
        byCodeUnit(left.moduleSpecifier, right.moduleSpecifier) ||
        byCodeUnit(left.localName, right.localName) ||
        byCodeUnit(left.kind, right.kind) ||
        byCodeUnit(left.importedName, right.importedName),
    );
  const inlineImportTypeProofs: PreparationInlineImportTypeProof[] = selection.relativeInlineImportTypes.map((item) => {
    const rewrite = rewriteRelative(item.originalSpecifier);
    return { ...item, targetSpecifier: rewrite.targetSpecifier, resolvedSourcePath: rewrite.resolvedSourcePath, proofBaselineHash: selection.sourceHash };
  });
  const donorImports = selection.retainedConsumers
    .map((item) => ({
      localName: item.name,
      importedName: item.name,
      moduleSpecifier: input.targetModuleSpecifier,
      kind: "named" as const,
      originallyTypeOnly: true,
      requiredAs: "type" as const,
      proofBaselineHash: selection.sourceHash,
    }))
    .toSorted((left, right) => byCodeUnit(left.moduleSpecifier, right.moduleSpecifier) || byCodeUnit(left.localName, right.localName));
  const reExportNames = selection.compatibilitySurface.map((item) => item.name).toSorted(byCodeUnit);
  const replay = renderTypeOnlyExtraction({
    baselineText: sourceText,
    baselineHash: selection.sourceHash,
    selected: selection.declarations.map((declaration) => ({
      ...declaration.extraction,
      name: declaration.name,
      kind: declaration.kind,
      originallyExported: declaration.originallyExported,
    })),
    targetPath: input.targetPath,
    moduleSpecifier: input.targetModuleSpecifier,
    targetImports,
    inlineImportTypeProofs,
    compatibility: { reExportNames, donorImports },
  });
  const selectorByExtraction = new Map(
    groups.flatMap((group) =>
      group.declarations.map((declaration) => [
        `${declaration.extractionStart}\0${declaration.extractionEnd}\0${declaration.extractionHash}`,
        declaration.selectorId,
      ]),
    ),
  );
  const targetDeclarationProofs = replay.declarations
    .map((proof) => {
      const selectorId = selectorByExtraction.get(`${proof.source.start}\0${proof.source.end}\0${proof.source.hash}`);
      if (!selectorId) throw new PlanningError(`replay proof has no matching declaration selector: ${proof.name}`);
      return {
        selectorId,
        targetStart: proof.targetSpan.start,
        targetEnd: proof.targetSpan.end,
        targetHash: proof.targetSpan.hash,
        targetExtractionStart: proof.targetExtraction.start,
        targetExtractionEnd: proof.targetExtraction.end,
        targetExtractionHash: proof.targetExtraction.hash,
        synthesizedExport: proof.synthesizedExport,
      };
    })
    .toSorted((left, right) => byCodeUnit(left.selectorId, right.selectorId));
  const manifest = createPreparationManifest({
    schemaVersion: 1,
    createdAt: baseline.committedAt,
    generator: { ...GENERATOR },
    baseline: { commit: baseline.commit, committerDate: baseline.committedAt, configDigest: configDigest(input.config) },
    graphDigest: input.graphDigest,
    declarations: groups,
    operations: [
      {
        kind: "extract-type-declarations",
        donor: {
          path: selection.sourcePath,
          preconditionHash: selection.sourceHash,
          preconditionMode: donorMode,
          resultHash: replay.donor.hash,
          resultMode: donorMode,
        },
        target: { path: input.targetPath, preconditionHash: MISSING, preconditionMode: "missing", resultHash: replay.target.hash, resultMode: 0o644 },
        moduleSpecifier: input.targetModuleSpecifier,
        declarations: groups,
        targetImportProofs: [...targetImportProofs.values()].toSorted(
          (left, right) =>
            byCodeUnit(left.targetSpecifier, right.targetSpecifier) ||
            byCodeUnit(left.localName, right.localName) ||
            byCodeUnit(left.kind, right.kind) ||
            byCodeUnit(left.importedName, right.importedName) ||
            byCodeUnit(left.originalSpecifier, right.originalSpecifier) ||
            byCodeUnit(left.resolvedSourcePath, right.resolvedSourcePath),
        ),
        inlineImportTypeProofs,
        targetImports,
        donorImports,
        reExportNames,
        targetDeclarationProofs,
        donorContents: replay.donor.text,
        targetContents: replay.target.text,
      },
    ],
    compatibilityReexports:
      selection.compatibilitySurface.length === 0
        ? []
        : [
            {
              fromPath: selection.sourcePath,
              toPath: input.targetPath,
              moduleSpecifier: input.targetModuleSpecifier,
              exports: selection.compatibilitySurface
                .map((item) => ({ name: item.name, typeOnly: true as const }))
                .toSorted((left, right) => byCodeUnit(left.name, right.name)),
            },
          ],
    changedFiles: [selection.sourcePath, input.targetPath].toSorted(byCodeUnit),
    commits: { prepare: input.rendering.commit },
    gates: {
      package: [...input.rendering.gates.package].toSorted(byCodeUnit),
      project: [...input.rendering.gates.project].toSorted(byCodeUnit),
      workspace: [...input.rendering.gates.workspace].toSorted(byCodeUnit),
    },
  });
  assertPreparationManifestValid(manifest);
  return manifest;
}

/** Git tree modes carry type bits; preparation journals own only POSIX permissions. */
