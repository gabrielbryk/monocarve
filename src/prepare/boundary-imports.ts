/**
 * The "existing-package" strategy: the retained module is a shim for a
 * package that already exists. Every consumer of the shim is rewritten to
 * import the real package instead — the exact specifier and symbol list the
 * config declares, never a guessed equivalent. When every consumer has been
 * rewritten in this same manifest and the boundary declares `retire`, the
 * shim itself is deleted.
 *
 * What this module refuses: rewriting a consumer that imports a symbol the
 * config's replacement list does not name. A config gap here is a stop, not
 * a best-effort substitution — the governing constraint from the proposal is
 * that Monocarve compiles and validates reviewer-declared policy, it never
 * chooses a domain contract on its own.
 */

import { resolve } from "node:path";

import { rewriteResolvedImportSpecifier } from "../codemod/imports.ts";
import { MonocarveError } from "../errors.ts";
import { byCodeUnit, hashText, type FileState } from "../util/hash.ts";
import type { ResolvedExistingPackageBoundary } from "./boundary-resolve.ts";
import type { DeleteModuleOperation, PreparationFileMutation, RewriteModuleSpecifierOperation } from "./manifest-types.ts";

export class BoundaryImportError extends MonocarveError {
  override readonly name = "BoundaryImportError";
}

/** One consumer of the retained module, as it exists at the preparation baseline. */
export interface RetainedImporterInput {
  readonly path: string;
  readonly preconditionHash: FileState;
  readonly mode: number;
  readonly text: string;
  /** Exact specifier this importer currently uses to reach the retained module. */
  readonly specifier: string;
  /** Exact bound names this importer takes through that specifier. */
  readonly importedSymbols: readonly string[];
  readonly moduleSpecifierCall?: string;
}

export interface PlanExistingPackageBoundaryInput {
  readonly rootDir: string;
  readonly boundary: ResolvedExistingPackageBoundary;
  readonly retainedPrecondition: FileState;
  readonly retainedMode: number | "missing";
  readonly importers: readonly RetainedImporterInput[];
  readonly moduleSpecifierCalls?: readonly string[];
  readonly resolutionExtensions?: readonly string[];
  readonly cssImportExtensions?: readonly string[];
}

export interface PlanExistingPackageBoundaryResult {
  readonly rewrites: readonly RewriteModuleSpecifierOperation[];
  readonly deletion?: DeleteModuleOperation;
}

/** Compile the full operation set for one "existing-package" boundary. */
export function planExistingPackageBoundary(input: PlanExistingPackageBoundaryInput): PlanExistingPackageBoundaryResult {
  const { boundary } = input;
  const donorPath = resolve(input.rootDir, boundary.retained);
  const importers = [...input.importers].sort((left, right) => byCodeUnit(left.path, right.path));
  const rewrites = importers.map((importer) => planImporterRewrite(input, donorPath, importer));
  return boundary.retire ? { rewrites, deletion: planDeletion(input, rewrites) } : { rewrites };
}

function planImporterRewrite(input: PlanExistingPackageBoundaryInput, donorPath: string, importer: RetainedImporterInput): RewriteModuleSpecifierOperation {
  const { boundary } = input;
  for (const symbol of importer.importedSymbols) {
    if (!boundary.replacementSymbols.includes(symbol)) {
      throw new BoundaryImportError(
        `${importer.path} imports ${symbol} from ${boundary.retained}, which is not in the declared replacement symbol list for boundary ${boundary.id}`,
      );
    }
  }
  const contents = rewriteResolvedImportSpecifier(
    importer.text,
    resolve(input.rootDir, importer.path),
    donorPath,
    boundary.replacementSpecifier,
    input.rootDir,
    input.moduleSpecifierCalls ?? [],
    input.resolutionExtensions ?? [],
    input.cssImportExtensions ?? [],
  );
  if (contents === importer.text) {
    throw new BoundaryImportError(`${importer.path} does not resolve to the retained module ${boundary.retained}; refusing an import rewrite with no effect`);
  }
  const file: PreparationFileMutation = {
    path: importer.path,
    preconditionHash: importer.preconditionHash,
    preconditionMode: importer.mode,
    resultHash: hashText(contents),
    resultMode: importer.mode,
  };
  return {
    kind: "rewrite-module-specifier",
    file,
    rewrites: [
      {
        from: importer.specifier,
        to: boundary.replacementSpecifier,
        symbols: [...importer.importedSymbols].sort(byCodeUnit),
        ...(importer.moduleSpecifierCall === undefined ? {} : { moduleSpecifierCall: importer.moduleSpecifierCall }),
      },
    ],
    contents,
  };
}

function planDeletion(input: PlanExistingPackageBoundaryInput, rewrites: readonly RewriteModuleSpecifierOperation[]): DeleteModuleOperation {
  const file: PreparationFileMutation = {
    path: input.boundary.retained,
    preconditionHash: input.retainedPrecondition,
    preconditionMode: input.retainedMode,
    // No result state exists for a deletion; see manifest-types.ts's
    // DeleteModuleOperation doc for why these fields carry no real meaning.
    resultHash: hashText(""),
    resultMode: 0,
  };
  return { kind: "delete-module", file, importerProof: rewrites.map((rewrite) => rewrite.file.path).sort(byCodeUnit) };
}
