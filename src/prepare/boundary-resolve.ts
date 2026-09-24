/**
 * Normalizes `compositionBoundaries` and `portPromotions` — the frontend and
 * backend vocabularies for one boundary-preparation mechanism, see
 * `src/config/schema-policy.ts` — into a single internal `ResolvedBoundary`
 * shape, so the builders (`boundary-imports.ts`, `boundary-port.ts`), proofs,
 * and (later) audit are written once instead of once per vocabulary.
 *
 * This module owns every config-level refusal for that normalization. What it
 * refuses to do: invent a replacement specifier, contract name, or adapter
 * this workspace's config did not declare; rename a promoted declaration
 * (`portPromotions.libraryPort` must name the same declaration the app
 * already has, because the preparation replay pipeline moves a declaration's
 * bytes verbatim and cannot synthesize a rename); or resolve a package name
 * to an on-disk path — that requires workspace/package-root knowledge this
 * module deliberately does not have, so a resolved "port" boundary reports
 * the config's declared identifiers, and the caller supplies concrete write
 * targets (mirroring how `src/prepare/build.ts` takes an explicit `targetPath`
 * rather than deriving one from config).
 */

import type { CompositionBoundariesConfig } from "../config/schema-policy.ts";
import type { PortPromotionsConfig } from "../config/schema-promotions.ts";
import { MonocarveError } from "../errors.ts";
import { byCodeUnit } from "../util/hash.ts";

export class BoundaryConfigError extends MonocarveError {
  override readonly name = "BoundaryConfigError";
}

export interface ResolvedExistingPackageBoundary {
  readonly id: string;
  readonly source: "compositionBoundaries";
  readonly strategy: "existing-package";
  readonly retained: string;
  readonly replacementSpecifier: string;
  readonly replacementSymbols: readonly string[];
  readonly retire: boolean;
  readonly selective: boolean;
}

export interface ResolvedPortBoundary {
  readonly id: string;
  readonly source: "compositionBoundaries" | "portPromotions";
  readonly strategy: "port";
  /** App-owned file the promoted declaration is selected from at baseline. */
  readonly retained: string;
  /** Exact name of the declaration as it exists in `retained` today. */
  readonly declarationName: string;
  /** Exact name the promoted declaration is published as (equals `declarationName`: no rename). */
  readonly contractName: string;
  /** True only for the explicit appConcreteTypes/libraryPorts config form. */
  readonly atomicDeclarationGroup?: boolean;
  /** Declared package identity the contract specifier resolves through; not a filesystem path. */
  readonly contractPackage: string;
  /** Workspace package that must already own the promoted contract target. */
  readonly targetPackage: string;
  /** Declared module identity within `contractPackage`; not a filesystem path. */
  readonly contractModule: string;
  /** Exact specifier a portable importer is rewritten to use. */
  readonly packageImport: string;
  /** Exhaustive symbol list importable through `packageImport`. */
  readonly symbols: readonly string[];
  /** App-owned adapter file to author from `template`, when this strategy needs one. */
  readonly appAdapter: string | undefined;
  readonly template: string | undefined;
  /** App-owned roots this boundary is meant to unblock. */
  readonly retainedRoots: readonly string[];
  readonly retire: boolean;
}

export type ResolvedBoundary = ResolvedExistingPackageBoundary | ResolvedPortBoundary;

export interface ResolveBoundariesInput {
  readonly compositionBoundaries: CompositionBoundariesConfig;
  readonly portPromotions: PortPromotionsConfig;
}

/** Normalize both config surfaces into one deterministically ordered list. */
export function resolveBoundaries(config: ResolveBoundariesInput): readonly ResolvedBoundary[] {
  const resolved = [...config.compositionBoundaries.map(resolveCompositionBoundary), ...config.portPromotions.map(resolvePortPromotion)].toSorted(
    (left, right) => byCodeUnit(left.id, right.id),
  );
  const seen = new Set<string>();
  for (const boundary of resolved) {
    if (seen.has(boundary.id))
      throw new BoundaryConfigError(`boundary id ${boundary.id} is declared more than once across compositionBoundaries and portPromotions`);
    seen.add(boundary.id);
  }
  return resolved;
}

function resolveCompositionBoundary(boundary: CompositionBoundariesConfig[number]): ResolvedBoundary {
  if (boundary.strategy === "existing-package") {
    if (!boundary.replacement) throw new BoundaryConfigError(`boundary ${boundary.id}: strategy "existing-package" requires a declared replacement`);
    return {
      id: boundary.id,
      source: "compositionBoundaries",
      strategy: "existing-package",
      retained: boundary.retained,
      replacementSpecifier: boundary.replacement.specifier,
      replacementSymbols: [...boundary.replacement.symbols].toSorted(byCodeUnit),
      retire: boundary.retire,
      selective: boundary.selective,
    };
  }
  if (!boundary.contract || !boundary.contractModule || !boundary.appAdapter || !boundary.packageImport || boundary.symbols.length === 0) {
    throw new BoundaryConfigError(
      `boundary ${boundary.id}: strategy "port" requires contract, contractModule, appAdapter, packageImport, and a non-empty symbols list`,
    );
  }
  if (!boundary.template) {
    throw new BoundaryConfigError(`boundary ${boundary.id}: strategy "port" requires a reviewed "template" id — the adapter is never synthesized`);
  }
  return {
    id: boundary.id,
    source: "compositionBoundaries",
    strategy: "port",
    retained: boundary.retained,
    declarationName: boundary.contract,
    contractName: boundary.contract,
    // compositionBoundaries does not separately name a contractPackage: the
    // bare specifier a consumer imports doubles as both the specifier and
    // the package identity in this vocabulary.
    contractPackage: boundary.packageImport,
    targetPackage: boundary.packageImport,
    contractModule: boundary.contractModule,
    packageImport: boundary.packageImport,
    symbols: [...boundary.symbols].toSorted(byCodeUnit),
    appAdapter: boundary.appAdapter,
    template: boundary.template,
    retainedRoots: [boundary.retained],
    retire: boundary.retire,
  };
}

function resolvePortPromotion(promotion: PortPromotionsConfig[number]): ResolvedPortBoundary {
  const references = promotion.appConcreteTypes ?? (promotion.appConcreteType ? [promotion.appConcreteType] : []);
  const ports = promotion.libraryPorts ?? (promotion.libraryPort ? [promotion.libraryPort] : []);
  if (references.length === 0 || references.length !== ports.length) {
    throw new BoundaryConfigError(`boundary ${promotion.id}: concrete declarations and library ports must be a non-empty paired group`);
  }
  const parsed = references.map((reference) => {
    const hashIndex = reference.indexOf("#");
    return { retained: reference.slice(0, hashIndex), name: reference.slice(hashIndex + 1) };
  });
  const retained = parsed[0]!.retained;
  if (parsed.some((item) => item.retained !== retained)) {
    throw new BoundaryConfigError(`boundary ${promotion.id}: every appConcreteTypes declaration must come from the same retained file`);
  }
  const declarationNames = parsed.map((item) => item.name);
  const mismatch = declarationNames.findIndex((name, index) => ports[index] !== name);
  if (mismatch !== -1) {
    throw new BoundaryConfigError(
      `boundary ${promotion.id}: library port (${ports[mismatch]}) must name the same declaration as app concrete type ` +
        `(${declarationNames[mismatch]}) — the preparation engine moves declaration bytes verbatim and does not synthesize renames`,
    );
  }
  const duplicate = declarationNames.find((name, index) => declarationNames.indexOf(name) !== index);
  if (duplicate) throw new BoundaryConfigError(`boundary ${promotion.id}: duplicate concrete declaration ${duplicate}`);
  const symbols = [...declarationNames].toSorted(byCodeUnit);
  return {
    id: promotion.id,
    source: "portPromotions",
    strategy: "port",
    retained,
    declarationName: declarationNames[0]!,
    contractName: declarationNames[0]!,
    ...(promotion.appConcreteTypes ? { atomicDeclarationGroup: true } : {}),
    contractPackage: promotion.contractPackage,
    targetPackage: promotion.targetPackage,
    contractModule: promotion.contractModule,
    packageImport: promotion.contractPackage,
    symbols,
    // portPromotions never authors a new adapter file: the app's existing
    // concrete type stays in place and is expected to already satisfy the
    // promoted port structurally.
    appAdapter: undefined,
    template: undefined,
    retainedRoots: [...promotion.retainedRoots].toSorted(byCodeUnit),
    retire: false,
  };
}
