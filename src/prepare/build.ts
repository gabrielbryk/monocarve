/** Compile a deterministic, replayable type-only preparation manifest. */
import { GENERATOR } from "../branding.ts";
import { configDigest, assertPreparationPolicyMatches, type MonocarveConfig } from "../config.ts";
import { PlanningError } from "../plan/context.ts";
import type { SeamPlan } from "../seams/types.ts";
import { resolveCommit, showBaseline } from "../util/git.ts";
import { byCodeUnit, hashJson, hashText, MISSING, type Sha256 } from "../util/hash.ts";
import { workspacePath } from "../util/paths.ts";
import { baselineFileMode, sortedGates, type PreparationManifestRendering } from "./build-shared.ts";
import { preparationCompilerOptions } from "./compiler-policy.ts";
import type {
  ExtractTypeDeclarationsOperation,
  PreparationDeclarationSelector,
  PreparationDeclarationGroupSelector,
  PreparationManifest,
  PreparationInlineImportTypeProof,
  PreparationTargetDeclarationProof,
  PreparationTargetImportProof,
} from "./manifest-types.ts";
import { createPreparationManifest, assertPreparationManifestValid } from "./manifest.ts";
import { renderTypeOnlyExtraction, type RenderTypeOnlyExtractionInput, type TypeOnlyExtractionReplay } from "./replay.ts";
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
  const reviewed = assertCompileInput(input);
  const baseline = resolveCommit(input.rootDir, input.baselineCommit);
  const donorMode = baselineFileMode(input.rootDir, baseline.commit, input.seam.sourcePath);
  const sourceText = readBaselineDonor(input, baseline.commit);
  const selection = selectTypeOnlyDeclarations({
    sourcePath: input.seam.sourcePath,
    sourceText,
    groupIds: reviewed,
    compilerOptions: preparationCompilerOptions(input.rootDir, input.config, input.seam.sourcePath),
  });
  assertClosureMatchesReview(reviewed, selection.closureGroupIds);
  const groups = declarationGroupSelectors(selection);
  const rewriteRelative = relativeRewriter(input, selection.sourcePath, baseline.commit);
  const { targetImports, targetImportProofs } = rewriteTargetImports(selection, rewriteRelative);
  const inlineImportTypeProofs: PreparationInlineImportTypeProof[] = selection.relativeInlineImportTypes.map((item) => {
    const rewrite = rewriteRelative(item.originalSpecifier);
    return { ...item, targetSpecifier: rewrite.targetSpecifier, resolvedSourcePath: rewrite.resolvedSourcePath, proofBaselineHash: selection.sourceHash };
  });
  const donorImports = retainedDonorImports(selection, input.targetModuleSpecifier);
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
  const operation: ExtractTypeDeclarationsOperation = {
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
    targetImportProofs: sortTargetImportProofs(targetImportProofs),
    inlineImportTypeProofs,
    targetImports,
    donorImports,
    reExportNames,
    targetDeclarationProofs: targetDeclarationProofs(groups, replay),
    donorContents: replay.donor.text,
    targetContents: replay.target.text,
  };
  const manifest = createPreparationManifest({
    schemaVersion: 1,
    createdAt: baseline.committedAt,
    generator: { ...GENERATOR },
    baseline: { commit: baseline.commit, committerDate: baseline.committedAt, configDigest: configDigest(input.config) },
    graphDigest: input.graphDigest,
    declarations: groups,
    operations: [operation],
    compatibilityReexports: compatibilityReexports(selection, input),
    changedFiles: [selection.sourcePath, input.targetPath].toSorted(byCodeUnit),
    commits: { prepare: input.rendering.commit },
    gates: sortedGates(input.rendering),
  });
  assertPreparationManifestValid(manifest);
  return manifest;
}

type TypeOnlySelection = ReturnType<typeof selectTypeOnlyDeclarations>;
type SelectedDeclaration = TypeOnlySelection["declarations"][number];
type TargetImport = RenderTypeOnlyExtractionInput["targetImports"][number];
type RelativeRewriter = (originalSpecifier: string) => RelativeTypeImportRewrite;
type MutableGroup = Omit<PreparationDeclarationGroupSelector, "declarations"> & { declarations: PreparationDeclarationSelector[] };

/** Refuse inputs that cannot describe one reviewed, type-only seam; returns the sorted reviewed selection. */
function assertCompileInput(input: CompilePreparationManifestInput): Sha256[] {
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
  assertSeamMatchesReview(input, reviewed);
  return reviewed;
}

function assertSeamMatchesReview(input: CompilePreparationManifestInput, reviewed: readonly Sha256[]): void {
  const proposed = input.seam.movedGroups.map((group) => group.id).toSorted(byCodeUnit);
  if (!sameSequence(reviewed, proposed)) {
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
}

function sameSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Read the donor at the resolved baseline and prove the target is new and the seam describes these bytes. */
function readBaselineDonor(input: CompilePreparationManifestInput, commit: string): string {
  const sourceText = showBaseline(input.rootDir, commit, input.seam.sourcePath);
  if (sourceText === null) throw new PlanningError(`preparation donor is absent from baseline: ${input.seam.sourcePath}`);
  if (showBaseline(input.rootDir, commit, input.targetPath) !== null) {
    throw new PlanningError(`preparation target already exists at baseline: ${input.targetPath}`);
  }
  if (hashText(sourceText) !== input.seam.sourceHash) throw new PlanningError("seam source hash does not match the resolved baseline donor");
  return sourceText;
}

function assertClosureMatchesReview(reviewed: readonly Sha256[], closure: readonly Sha256[]): void {
  if (!sameSequence(reviewed, closure)) {
    throw new PlanningError("type dependency closure expands beyond the operator-reviewed seam; review the expanded declaration groups before compiling");
  }
}

/** Group selected declarations by group id, ordered by source position. */
function declarationGroupSelectors(selection: TypeOnlySelection): PreparationDeclarationGroupSelector[] {
  const declarations = new Map<Sha256, MutableGroup>();
  for (const declaration of selection.declarations) {
    const current = declarations.get(declaration.groupId) ?? {
      groupId: declaration.groupId,
      sourcePath: selection.sourcePath,
      name: declaration.name,
      space: "type" as const,
      declarations: [],
    };
    current.declarations.push(declarationSelector(selection, declaration));
    declarations.set(declaration.groupId, current);
  }
  return [...declarations.values()]
    .map((group) => ({
      ...group,
      declarations: [...group.declarations].toSorted(
        (left, right) => left.span.start - right.span.start || byCodeUnit(left.declarationId, right.declarationId),
      ),
    }))
    .toSorted((left, right) => left.declarations[0]!.span.start - right.declarations[0]!.span.start || byCodeUnit(left.groupId, right.groupId));
}

function declarationSelector(selection: TypeOnlySelection, declaration: SelectedDeclaration): PreparationDeclarationSelector {
  const declarationId = hashJson({
    sourcePath: selection.sourcePath,
    name: declaration.name,
    kind: declaration.kind,
    start: declaration.declaration.start,
    end: declaration.declaration.end,
    spanHash: declaration.declaration.hash,
  });
  return {
    declarationId,
    sourcePath: selection.sourcePath,
    sourceHash: selection.sourceHash,
    name: declaration.name,
    kind: declaration.kind,
    space: "type",
    originallyExported: declaration.originallyExported,
    span: declaration.declaration,
    selectorId: hashJson({
      declarationId,
      sourcePath: selection.sourcePath,
      sourceHash: selection.sourceHash,
      extractionStart: declaration.extraction.start,
      extractionEnd: declaration.extraction.end,
      extractionHash: declaration.extraction.hash,
    }),
    extractionStart: declaration.extraction.start,
    extractionEnd: declaration.extraction.end,
    extractionHash: declaration.extraction.hash,
  };
}

/** Resolve one donor-relative specifier through the caller's configured proof, refusing unproven rewrites. */
function relativeRewriter(input: CompilePreparationManifestInput, donorPath: string, baselineCommit: string): RelativeRewriter {
  return (originalSpecifier) => {
    const rewrite = input.rewriteRelativeTypeImport?.({ donorPath, targetPath: input.targetPath, originalSpecifier, baselineCommit });
    if (!rewrite) throw new PlanningError(`relative type import requires a configured rewrite proof: ${originalSpecifier}`);
    workspacePath(input.rootDir, rewrite.resolvedSourcePath);
    if (showBaseline(input.rootDir, baselineCommit, rewrite.resolvedSourcePath) === null)
      throw new PlanningError(`relative type import proof resolves no baseline source: ${rewrite.resolvedSourcePath}`);
    if (!rewrite.targetSpecifier.startsWith("."))
      throw new PlanningError(`relative type import proof must produce a relative target specifier for ${originalSpecifier}`);
    return rewrite;
  };
}

function rewriteTargetImports(
  selection: TypeOnlySelection,
  rewriteRelative: RelativeRewriter,
): { targetImports: TargetImport[]; targetImportProofs: Map<string, PreparationTargetImportProof> } {
  const targetImportProofs = new Map<string, PreparationTargetImportProof>();
  const targetImports = selection.imports
    .map((item) => {
      if (!item.moduleSpecifier.startsWith(".")) return { ...item, proofBaselineHash: selection.sourceHash };
      const rewrite = rewriteRelative(item.moduleSpecifier);
      const proof: PreparationTargetImportProof = {
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
  return { targetImports, targetImportProofs };
}

function sortTargetImportProofs(proofs: ReadonlyMap<string, PreparationTargetImportProof>): PreparationTargetImportProof[] {
  return [...proofs.values()].toSorted(
    (left, right) =>
      byCodeUnit(left.targetSpecifier, right.targetSpecifier) ||
      byCodeUnit(left.localName, right.localName) ||
      byCodeUnit(left.kind, right.kind) ||
      byCodeUnit(left.importedName, right.importedName) ||
      byCodeUnit(left.originalSpecifier, right.originalSpecifier) ||
      byCodeUnit(left.resolvedSourcePath, right.resolvedSourcePath),
  );
}

function retainedDonorImports(selection: TypeOnlySelection, targetModuleSpecifier: string): TargetImport[] {
  return selection.retainedConsumers
    .map((item) => ({
      localName: item.name,
      importedName: item.name,
      moduleSpecifier: targetModuleSpecifier,
      kind: "named" as const,
      originallyTypeOnly: true,
      requiredAs: "type" as const,
      proofBaselineHash: selection.sourceHash,
    }))
    .toSorted((left, right) => byCodeUnit(left.moduleSpecifier, right.moduleSpecifier) || byCodeUnit(left.localName, right.localName));
}

/** Pair every rendered target declaration with the donor selector whose extraction produced it. */
function targetDeclarationProofs(
  groups: readonly PreparationDeclarationGroupSelector[],
  replay: TypeOnlyExtractionReplay,
): PreparationTargetDeclarationProof[] {
  const selectorByExtraction = new Map(
    groups.flatMap((group) =>
      group.declarations.map((declaration) => [
        `${declaration.extractionStart}\0${declaration.extractionEnd}\0${declaration.extractionHash}`,
        declaration.selectorId,
      ]),
    ),
  );
  return replay.declarations
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
}

function compatibilityReexports(selection: TypeOnlySelection, input: CompilePreparationManifestInput): PreparationManifest["compatibilityReexports"] {
  if (selection.compatibilitySurface.length === 0) return [];
  return [
    {
      fromPath: selection.sourcePath,
      toPath: input.targetPath,
      moduleSpecifier: input.targetModuleSpecifier,
      exports: selection.compatibilitySurface
        .map((item) => ({ name: item.name, typeOnly: true as const }))
        .toSorted((left, right) => byCodeUnit(left.name, right.name)),
    },
  ];
}
