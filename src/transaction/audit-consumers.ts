/**
 * Proof 2: no source still resolves into a donor path, and the declared
 * consumers are wired exactly as the manifest claims.
 *
 * The scan also produces two things other proofs consume: the boundary-edge
 * failures proof 3 adds its own surface failures to, and the moved-path edges
 * the graph evidence reports. They are collected here because they fall out of
 * the same single pass over the repository's sources — walking it again per
 * proof would be the same read, twice, with no more evidence.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { MonocarveConfig } from "../config.ts";
import { inventoryModuleReferences } from "../codemod/imports.ts";
import {
  applicationTargetOf,
  boundaryEdgeKey,
  isBoundaryGovernedFile,
  recordedBoundaryEdgeKeys,
} from "../plan/boundary-baseline.ts";
import { showBaseline } from "../util/git.ts";
import type {
  ExtractionManifest,
  MoveOperation,
  MoveWithRewriteOperation,
} from "../plan/manifest.ts";
import { findStaticFsReferences } from "../plan/static-fs-references.ts";
import { relativeCandidates, repositorySources } from "./audit-helpers.ts";
import { stillNamesADonor } from "./audit-graph.ts";

type AnyMove = MoveOperation | MoveWithRewriteOperation;
type ModuleReference = ReturnType<typeof inventoryModuleReferences>[number];

export interface ConsumerEvidence {
  readonly consumerFailures: readonly string[];
  readonly boundaryFailures: readonly string[];
  readonly movedPathEdges: readonly string[];
  readonly observedBaselineKeys: ReadonlySet<string>;
  /** Files walked, for the proof's check count. */
  readonly sourceCount: number;
}

interface ScanState {
  readonly consumerFailures: string[];
  readonly boundaryFailures: string[];
  readonly movedPathEdges: string[];
  readonly observedBaselineKeys: Set<string>;
  readonly baselineKeys: ReadonlySet<string>;
  readonly movedSourcePaths: ReadonlySet<string>;
  readonly movedTargets: ReadonlySet<string>;
}

// Boundary edges the reviewed plan recorded as already present are
// evidence, not failures: the audit's job is to prove this transaction
// introduced none, not to re-litigate debt the reviewer approved with the
// plan. An absent record is an empty baseline, so a manifest compiled
// before the baseline existed still fails on every edge.
function collectBoundaryEdges(
  config: MonocarveConfig,
  rootDir: string,
  file: string,
  references: readonly ModuleReference[],
  state: ScanState,
): void {
  if (!isBoundaryGovernedFile(config, file)) return;
  for (const reference of references) {
    const target = applicationTargetOf(config, rootDir, reference);
    if (target === undefined) continue;
    const key = boundaryEdgeKey({ file, target });
    if (state.baselineKeys.has(key)) {
      state.observedBaselineKeys.add(key);
      continue;
    }
    state.boundaryFailures.push(`${file} imports application code: ${reference.specifier}`);
  }
}

function collectMovedPathEdges(
  config: MonocarveConfig,
  absolute: string,
  file: string,
  references: readonly ModuleReference[],
  state: ScanState,
): void {
  for (const reference of references) {
    const specifier = reference.specifier;
    if (!specifier) continue;
    if (specifier.startsWith(".")) {
      const candidates = relativeCandidates(config, absolute, specifier);
      if (candidates.some((candidate) => state.movedSourcePaths.has(candidate))) {
        state.movedPathEdges.push(`${file} -> ${specifier}`);
      } else if (state.movedTargets.has(file) && !candidates.some(existsSync)) {
        // A moved file whose relative import now resolves to nothing was
        // orphaned from something that stayed behind — typically an asset.
        state.movedPathEdges.push(`${file} -> ${specifier} (unresolved)`);
      }
    } else if (reference.resolved && state.movedSourcePaths.has(resolve(reference.resolved))) {
      state.movedPathEdges.push(`${file} -> ${specifier}`);
    }
  }
}

function scanSource(
  config: MonocarveConfig,
  manifest: ExtractionManifest,
  rootDir: string,
  moves: readonly AnyMove[],
  file: string,
  state: ScanState,
): void {
  const absolute = resolve(rootDir, file);
  if (!existsSync(absolute)) return;
  const current = readFileSync(absolute, "utf8");
  const references = inventoryModuleReferences(current, absolute, true, rootDir, config.moduleSpecifierCalls);

  collectBoundaryEdges(config, rootDir, file, references, state);
  collectMovedPathEdges(config, absolute, file, references, state);

  // Re-derived independently of every operation the plan declares: a static
  // filesystem reference (`resolve(import.meta.dir, "…")`) is invisible to
  // `inventoryModuleReferences` above, so this is the only place that would
  // ever notice one still naming a path nothing occupies any more.
  for (const match of findStaticFsReferences(current, absolute)) {
    if (state.movedSourcePaths.has(match.resolvedAbsolute)) {
      state.movedPathEdges.push(`${file} -> ${match.literal} (static fs reference)`);
    }
  }

  if (file.startsWith(`${manifest.target.packageRoot}/`)) return;
  if (stillNamesADonor(config, rootDir, absolute, references, moves)) {
    state.consumerFailures.push(`old-path consumer remains: ${file}`);
  }
}

/**
 * The owner package.json half of the declared-consumer proof.
 *
 * Retained tests are consumers too, but the runtime package must not leak
 * into their owner's production graph. The manifest makes this claim
 * explicit, so verify the landed owner manifest rather than trusting the
 * wiring operation that happened to be planned.
 */
function dependencySectionFailures(
  manifest: ExtractionManifest,
  rootDir: string,
  consumer: ExtractionManifest["consumers"][number],
): string[] {
  const manifestPath = resolve(rootDir, consumer.owner, "package.json");
  // A low-level journal fixture can model an import rewrite without modelling
  // the owning workspace package at all. There is no package section to
  // inspect in that deliberately partial fixture; compiler manifests always
  // have an owner manifest before emitting consumer wiring.
  if (!existsSync(manifestPath)) return [];
  try {
    const ownerManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const section = consumer.dependencySection === "dev" ? ownerManifest.devDependencies : ownerManifest.dependencies;
    const opposite = consumer.dependencySection === "dev" ? ownerManifest.dependencies : ownerManifest.devDependencies;
    // Some low-level transaction fixtures declare a consumer rewrite without
    // the package-wiring operation; they are not full compiler manifests and
    // therefore make no section claim this proof can test. Every compiler
    // manifest that wires a new consumer either writes its owner package.json
    // or starts from one already declaring the package, and must satisfy the
    // exact-section proof below.
    const declaredByPlan = manifest.operations.some(
      (operation) => operation.kind === "write-file" && operation.path === `${consumer.owner}/package.json`,
    );
    const declaredOnDisk = section?.[manifest.target.packageName] !== undefined || opposite?.[manifest.target.packageName] !== undefined;
    if ((declaredByPlan || declaredOnDisk) && (section?.[manifest.target.packageName] === undefined || opposite?.[manifest.target.packageName] !== undefined)) {
      return [`consumer dependency section does not match manifest: ${consumer.file}`];
    }
  } catch {
    return [`cannot verify consumer dependency section: ${consumer.file}`];
  }
  return [];
}

function collectDeclaredConsumerFailures(
  manifest: ExtractionManifest,
  rootDir: string,
  failures: string[],
): void {
  for (const consumer of manifest.consumers) {
    const operation = manifest.operations.find(
      (candidate) => candidate.kind === "rewrite-import" && candidate.file === consumer.file,
    );
    if (!operation) {
      failures.push(`declared consumer has no rewrite operation: ${consumer.file}`);
      continue;
    }
    const baseline = showBaseline(rootDir, manifest.baselineCommit, consumer.file);
    if (baseline === null || !baseline.includes(consumer.expectedImporter)) {
      failures.push(`baseline of ${consumer.file} never contained ${consumer.expectedImporter}`);
    }
    if (!existsSync(resolve(rootDir, consumer.file))) {
      failures.push(`declared consumer no longer exists: ${consumer.file}`);
    }
    // A retained file inside the target package may need its donor import
    // rewritten to a target subpath, but the target package must not declare
    // a dependency on itself. Keep the rewrite proof above and skip only the
    // package-dependency section check below.
    if (consumer.owner === manifest.target.packageRoot) continue;
    failures.push(...dependencySectionFailures(manifest, rootDir, consumer));
  }
}

export function consumerEvidence(
  config: MonocarveConfig,
  manifest: ExtractionManifest,
  rootDir: string,
  moves: readonly AnyMove[],
): ConsumerEvidence {
  const state: ScanState = {
    consumerFailures: [],
    boundaryFailures: [],
    movedPathEdges: [],
    observedBaselineKeys: new Set<string>(),
    baselineKeys: recordedBoundaryEdgeKeys(manifest.boundaryBaseline),
    movedSourcePaths: new Set(moves.map((move) => resolve(rootDir, move.source))),
    movedTargets: new Set(moves.map((move) => move.target)),
  };

  const sources = repositorySources(config, rootDir);
  for (const file of sources) scanSource(config, manifest, rootDir, moves, file, state);

  collectDeclaredConsumerFailures(manifest, rootDir, state.consumerFailures);

  if (state.movedPathEdges.length > 0) {
    state.consumerFailures.push(`references into moved paths remain: ${[...new Set(state.movedPathEdges)].sort()[0]}`);
  }
  return {
    consumerFailures: state.consumerFailures,
    boundaryFailures: state.boundaryFailures,
    movedPathEdges: state.movedPathEdges,
    observedBaselineKeys: state.observedBaselineKeys,
    sourceCount: sources.length,
  };
}
