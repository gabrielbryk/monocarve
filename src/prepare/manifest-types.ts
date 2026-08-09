import type { DeclarationKind, SourceSpan } from "../symbols/types.ts";
import type { FileState, Sha256 } from "../util/hash.ts";

/** The independently replayable preparation-plan format. */
export const PREPARATION_MANIFEST_SCHEMA_VERSION = 1 as const;

export interface PreparationCommitSpec {
  readonly subject: string;
  readonly body?: string;
}

/** The immutable revision and resolved configuration the plan was compiled from. */
export interface PreparationBaseline {
  readonly commit: string;
  /** The baseline commit's committer date; it is also the manifest's createdAt. */
  readonly committerDate: string;
  readonly configDigest: Sha256;
}

/**
 * One declaration selected from the donor source text.
 *
 * The declaration id gives the analyzer identity, while the span gives replay a
 * byte-level precondition. Keeping both prevents a same-named declaration from
 * being silently substituted after the graph was analyzed.
 */
export interface PreparationDeclarationSelector {
  readonly declarationId: Sha256;
  /** Identity of the full, trivia-inclusive removal recipe. */
  readonly selectorId: Sha256;
  readonly sourcePath: string;
  readonly sourceHash: Sha256;
  readonly name: string;
  readonly kind: DeclarationKind;
  readonly space: "type";
  /** Whether this physical declaration was exported by the donor baseline. */
  readonly originallyExported: boolean;
  readonly span: SourceSpan;
  /** Exact source region moved by replay, including attached JSDoc/trivia. */
  readonly extractionStart: number;
  readonly extractionEnd: number;
  readonly extractionHash: Sha256;
}

/** A complete merge group that must be extracted as an inseparable unit. */
export interface PreparationDeclarationGroupSelector {
  readonly groupId: Sha256;
  readonly sourcePath: string;
  readonly name: string;
  readonly space: "type";
  readonly declarations: readonly PreparationDeclarationSelector[];
}

/** Expected before and after states for one changed file. */
export interface PreparationFileMutation {
  readonly path: string;
  readonly preconditionHash: FileState;
  readonly preconditionMode: number | "missing";
  readonly resultHash: Sha256;
  readonly resultMode: number;
}

/** A donor-relative import rewritten for the new target module location. */
export interface PreparationTargetImportProof {
  readonly originalSpecifier: string;
  readonly targetSpecifier: string;
  /** Repository-relative module resolved from the donor baseline. */
  readonly resolvedSourcePath: string;
  /** Exact checker-proven binding rendered in the target import. */
  readonly localName: string;
  readonly importedName: string | "default" | "*";
  readonly kind: "default" | "namespace" | "named";
  readonly originallyTypeOnly: boolean;
  readonly requiredAs: "type";
  /** The donor hash against which this resolution was proven. */
  readonly proofBaselineHash: Sha256;
}

/** Exact donor occurrence of a relative inline `import("...")` type rewritten in the target. */
export interface PreparationInlineImportTypeProof {
  readonly originalSpecifier: string;
  readonly targetSpecifier: string;
  readonly resolvedSourcePath: string;
  /** UTF-16 bounds of the string literal, including quotes, in the donor baseline. */
  readonly start: number;
  readonly end: number;
  readonly sourceHash: Sha256;
  readonly proofBaselineHash: Sha256;
}

/** Complete checker-proven binding replayed as an `import type` declaration. */
export interface PreparationCheckerProvenTypeImport {
  readonly moduleSpecifier: string;
  readonly importedName: string | "default" | "*";
  readonly localName: string;
  readonly kind: "default" | "namespace" | "named";
  readonly originallyTypeOnly: boolean;
  readonly requiredAs: "type";
  readonly proofBaselineHash: Sha256;
}

/** Exact rendered target declaration corresponding to one donor selector. */
export interface PreparationTargetDeclarationProof {
  readonly selectorId: Sha256;
  /** Core declaration bounds, excluding attached trivia. */
  readonly targetStart: number;
  readonly targetEnd: number;
  readonly targetHash: Sha256;
  /** Full rendered declaration bounds, including target-side trivia. */
  readonly targetExtractionStart: number;
  readonly targetExtractionEnd: number;
  readonly targetExtractionHash: Sha256;
  /** True only when rendering added `export` to an originally private type. */
  readonly synthesizedExport: boolean;
}

/**
 * A replayable, type-only extraction. Both output texts are present because
 * replay must verify the bytes it writes without reconstructing a transform.
 */
export interface ExtractTypeDeclarationsOperation {
  readonly kind: "extract-type-declarations";
  readonly donor: PreparationFileMutation;
  readonly target: PreparationFileMutation;
  /** Exact specifier replay uses from donor to the new type module. */
  readonly moduleSpecifier: string;
  readonly declarations: readonly PreparationDeclarationGroupSelector[];
  /** Every rewritten donor-relative import needed by the extracted target. */
  readonly targetImportProofs: readonly PreparationTargetImportProof[];
  /** Every relative inline import type in the moved declaration bytes. */
  readonly inlineImportTypeProofs?: readonly PreparationInlineImportTypeProof[];
  /** Complete replay recipe; audit must not infer these bindings from output text. */
  readonly targetImports: readonly PreparationCheckerProvenTypeImport[];
  readonly donorImports: readonly PreparationCheckerProvenTypeImport[];
  readonly reExportNames: readonly string[];
  /** One exact target declaration proof for every extracted donor selector. */
  readonly targetDeclarationProofs: readonly PreparationTargetDeclarationProof[];
  readonly donorContents: string;
  readonly targetContents: string;
}

/** A replayable write not already represented by an extraction's donor/target. */
export interface PreparationWriteFileOperation {
  readonly kind: "write-file";
  readonly file: PreparationFileMutation;
  /**
   * `"port-contract"`/`"app-adapter"` are the boundary-preparation ("port"
   * strategy) writes: a contract module promoted out of a retained module,
   * and the app-owned adapter that satisfies it. Both are ordinary,
   * fully-reviewable write-file operations — see `src/prepare/boundary-port.ts`.
   */
  readonly purpose: "compatibility-reexport" | "wiring" | "port-contract" | "port-package-export" | "app-adapter" | "value-split";
  readonly contents: string;
}

/**
 * A boundary-preparation ("existing-package" strategy) consumer rewrite: one
 * importer of a retained shim, repointed to the real package the config
 * declares as its replacement. `rewrites` records every exact specifier
 * substitution this file's `contents` performs, each carrying the exact
 * symbol names it was proven safe to move — see `src/prepare/boundary-imports.ts`.
 */
export interface RewriteModuleSpecifierOperation {
  readonly kind: "rewrite-module-specifier";
  readonly file: PreparationFileMutation;
  readonly rewrites: readonly {
    readonly from: string;
    readonly to: string;
    readonly symbols: readonly string[];
    /** Imported names deliberately left on `from` by a symbol-selective split. */
    readonly retainedSymbols?: readonly string[];
    /** Configured module-specifier call (for example `vi.mock`) instead of an import binding. */
    readonly moduleSpecifierCall?: string;
  }[];
  /** Full replayable text, exactly as extract-type-declarations carries it. */
  readonly contents: string;
}

/**
 * A retained shim deleted once `src/prepare/boundary-imports.ts` proved every
 * baseline importer was rewritten away from it in this same manifest.
 *
 * `file.resultHash`/`file.resultMode` are structurally present because this
 * operation shares `PreparationFileMutation` with every other file effect in
 * the manifest, but neither describes a real result state for a deletion —
 * there is no post-state to hash. Replay/audit (a later stage) must treat
 * `kind: "delete-module"` as "assert the precondition, then remove the path",
 * never read the result fields as a target to write.
 */
export interface DeleteModuleOperation {
  readonly kind: "delete-module";
  readonly file: PreparationFileMutation;
  /**
   * The exact importer paths this manifest's own rewrite-module-specifier
   * operations rewrote away from the deleted module — i.e. the exhaustive
   * baseline importer set, proven empty *after* those rewrites are applied.
   * A later validation stage is expected to assert this list exactly equals
   * the rewritten paths, and that a fresh post-replay graph query finds none
   * of them still importing the deleted path.
   */
  readonly importerProof: readonly string[];
}

/** Explicit, byte-recorded conversion of orphaned generated output to source. */
export interface AdoptGeneratedSourceOperation {
  readonly kind: "adopt-generated-source";
  readonly file: PreparationFileMutation;
  readonly declaredSource: string;
  readonly policySpecifier: string;
  readonly removedHeader: { readonly lines: number; readonly hash: Sha256 };
  readonly contents: string;
}

/** A generator deleted only with an exhaustive proof of its former outputs. */
export interface DeleteGeneratedSourceGeneratorOperation {
  readonly kind: "delete-generated-source-generator";
  readonly file: PreparationFileMutation;
  readonly adoptedOutputs: readonly string[];
}

export type PreparationReplayOperation =
  | ExtractTypeDeclarationsOperation
  | PreparationWriteFileOperation
  | RewriteModuleSpecifierOperation
  | DeleteModuleOperation
  | AdoptGeneratedSourceOperation
  | DeleteGeneratedSourceGeneratorOperation;

/** A type-only surface retained at the old module path after preparation. */
export interface CompatibilityReexportIntent {
  readonly fromPath: string;
  readonly toPath: string;
  /** Exact specifier rendered into the donor's `export type` statement. */
  readonly moduleSpecifier: string;
  readonly exports: readonly { readonly name: string; readonly typeOnly: true }[];
}

export interface PreparationGates {
  readonly package: readonly string[];
  readonly project: readonly string[];
  readonly workspace: readonly string[];
}

export interface PreparationManifest {
  readonly schemaVersion: typeof PREPARATION_MANIFEST_SCHEMA_VERSION;
  readonly planId: string;
  readonly createdAt: string;
  readonly generator: { readonly name: string; readonly version: string };
  readonly baseline: PreparationBaseline;
  /** Digest of the fresh workspace graph used to select this preparation. */
  readonly graphDigest: Sha256;
  /** Exact compiler-selected input used to render repository preparation policy. */
  readonly policyAnchor?: {
    readonly sourcePath: string;
    readonly targetPath: string;
    readonly targetModuleSpecifier: string;
  };
  readonly declarations: readonly PreparationDeclarationGroupSelector[];
  readonly operations: readonly PreparationReplayOperation[];
  /** Config-bound generated artifacts invalidated by this preparation. */
  readonly generatedArtifacts?: readonly {
    readonly path: string;
    readonly source: string;
    readonly regenerate: string;
  }[];
  /** Config-bound generators that must run after replay and before audit/gates. */
  readonly postJournalPreparers?: readonly {
    readonly id: string;
    readonly command: string;
    readonly outputs: readonly string[];
    readonly verify?: string;
  }[];
  readonly compatibilityReexports: readonly CompatibilityReexportIntent[];
  /** Exactly the workspace-relative paths the preparation replay may mutate. */
  readonly changedFiles: readonly string[];
  readonly commits: { readonly prepare: PreparationCommitSpec };
  readonly gates: PreparationGates;
}

/** All manifest fields except the deterministic identity derived from them. */
export type PreparationManifestDraft = Omit<PreparationManifest, "planId">;

export interface PreparationValidationIssue {
  readonly rule: string;
  readonly message: string;
  readonly path?: string;
}

export interface PreparationValidationResult {
  readonly ok: boolean;
  readonly issues: readonly PreparationValidationIssue[];
}

/**
 * Optional live states supplied by an apply/audit boundary. The manifest layer
 * deliberately does not read the filesystem, so validation remains pure.
 */
export interface ValidatePreparationManifestOptions {
  /** Required when a campaign must prove this child used its fresh rescan. */
  readonly expectedGraphDigest?: Sha256;
  readonly currentFiles?: Readonly<Record<string, FileState>>;
  /**
   * Optional live donor texts. Supplying these makes selector span hashes a
   * checkable proof instead of a claim; callers obtain the bytes themselves.
   */
  readonly currentContents?: Readonly<Record<string, string>>;
}
