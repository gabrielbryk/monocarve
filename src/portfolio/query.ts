import { isAbsolute } from "node:path";

import type { MonocarveConfig } from "../config.ts";
import { MonocarveError } from "../errors.ts";
import type { Scc } from "../graph/model.ts";
import { byCodeUnit, stableStringify } from "../util/hash.ts";
import { normalizePath, relativeWorkspacePath } from "../util/paths.ts";
import type { Portfolio, PortfolioCandidate, RecipeStep, RejectionCode, RetainedBlocker } from "./types.ts";

export type CandidateEligibility = "all" | "eligible" | "blocked";

export interface CandidateQuery {
  /** Exact stable candidate id. A missing id is an error, not an empty result. */
  readonly id?: string;
  /** Absolute or workspace-relative file/directory to intersect with the claim. */
  readonly path?: string;
  readonly eligibility?: CandidateEligibility;
}

export interface CandidateBlockerDetail {
  readonly code: RejectionCode;
  readonly detail: string;
  readonly edges: readonly string[];
}

export interface CandidateTargetSuggestion {
  readonly packageName: string;
  readonly packageRoot: string;
}

export interface CandidateDetail {
  readonly id: string;
  readonly application: string;
  readonly eligible: boolean;
  readonly score: number;
  readonly lineCount: number;
  readonly seed: Scc;
  readonly sccs: readonly Scc[];
  /** Complete claimed path closure, including travelling tests and assets. */
  readonly closure: readonly string[];
  readonly files: readonly string[];
  readonly tests: readonly string[];
  readonly assets: readonly string[];
  readonly blockers: readonly CandidateBlockerDetail[];
  readonly warnings: readonly string[];
  readonly targetSuggestion: CandidateTargetSuggestion;
  /** `"extraction" | "preparation"`, absent for a candidate built before ranking wired classification. */
  readonly classification?: "extraction" | "preparation";
  /** Retained-root edges this closure crosses, sorted by target. */
  readonly retainedBlockers: readonly RetainedBlocker[];
  /** What would unblock each retained blocker, one step per blocker. */
  readonly recipe: readonly RecipeStep[];
}

export class CandidateLookupError extends MonocarveError {
  override readonly name = "CandidateLookupError";
}

/** Query portfolio candidates and return a canonical, presentation-safe view. */
export function queryCandidates(
  portfolio: Portfolio,
  config: MonocarveConfig,
  query: CandidateQuery = {},
): CandidateDetail[] {
  if (query.id !== undefined && !portfolio.candidates.some((candidate) => candidate.id === query.id)) {
    throw new CandidateLookupError(`candidate not found: ${query.id}`);
  }

  const path = query.path === undefined ? undefined : queryPath(portfolio.rootDir, query.path);
  const eligibility = query.eligibility ?? "all";
  return portfolio.candidates
    .filter((candidate) => query.id === undefined || candidate.id === query.id)
    .filter((candidate) => matchesEligibility(candidate, eligibility))
    .filter((candidate) => path === undefined || intersects(candidate, path))
    .map((candidate) => candidateDetail(candidate, config))
    .sort(compareDetails);
}

export function serializeCandidateDetails(details: readonly CandidateDetail[]): string {
  return `${stableStringify([...details].sort(compareDetails), 2)}\n`;
}

/** Deterministic compact text intended for terminals and orchestration logs. */
export function formatCandidateTable(details: readonly CandidateDetail[]): string {
  const rows = [...details].sort(compareDetails).map((candidate) => [
    candidate.id,
    candidate.eligible ? "eligible" : "blocked",
    candidate.classification ?? "-",
    String(candidate.score),
    String(candidate.lineCount),
    String(candidate.closure.length),
    candidate.targetSuggestion.packageName,
  ]);
  const table = [["ID", "STATE", "CLASS", "SCORE", "LOC", "PATHS", "TARGET"], ...rows];
  const widths = table[0]!.map((_, column) => Math.max(...table.map((row) => row[column]!.length)));
  return `${table.map((row) => row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd()).join("\n")}\n`;
}

function candidateDetail(candidate: PortfolioCandidate, config: MonocarveConfig): CandidateDetail {
  const sorted = (values: readonly string[]): string[] => [...new Set(values)].sort(byCodeUnit);
  return {
    id: candidate.id,
    application: candidate.application,
    eligible: candidate.eligible,
    score: candidate.score,
    lineCount: candidate.lineCount,
    seed: canonicalScc(candidate.seed),
    sccs: candidate.sccs.map(canonicalScc).sort((left, right) => byCodeUnit(left.id, right.id)),
    closure: sorted([...candidate.files, ...candidate.tests, ...candidate.assets]),
    files: sorted(candidate.files),
    tests: sorted(candidate.tests),
    assets: sorted(candidate.assets),
    blockers: candidate.rejectionReasons
      .map((reason) => ({ code: reason.code, detail: reason.detail, edges: sorted(reason.edges) }))
      .sort((left, right) => byCodeUnit(left.code, right.code) || byCodeUnit(left.detail, right.detail)),
    warnings: sorted(candidate.warnings),
    targetSuggestion: targetSuggestion(candidate.suggestedPackageName, config),
    ...(candidate.classification === undefined ? {} : { classification: candidate.classification }),
    retainedBlockers: [...(candidate.retainedBlockers ?? [])].sort((left, right) => byCodeUnit(left.target, right.target)),
    recipe: [...(candidate.recipe ?? [])].sort((left, right) => byCodeUnit(left.blocker.target, right.blocker.target)),
  };
}

function canonicalScc(scc: Scc): Scc {
  return { id: scc.id, members: [...new Set(scc.members)].sort(byCodeUnit) };
}

function targetSuggestion(packageName: string, config: MonocarveConfig): CandidateTargetSuggestion {
  const bareName = config.packageScope && packageName.startsWith(config.packageScope)
    ? packageName.slice(config.packageScope.length)
    : packageName;
  return {
    packageName,
    packageRoot: normalizePath(`${config.packageRoots[0]!}/${bareName}`),
  };
}

function queryPath(rootDir: string, path: string): string {
  const normalized = isAbsolute(path) ? relativeWorkspacePath(rootDir, path) : normalizePath(path);
  if (!normalized || normalized.split("/").some((part) => part === ".." || part === "")) {
    throw new CandidateLookupError(`candidate path must be workspace-relative: ${path}`);
  }
  return normalized.replace(/\/$/, "");
}

function intersects(candidate: PortfolioCandidate, path: string): boolean {
  const prefix = `${path}/`;
  return [...candidate.files, ...candidate.tests, ...candidate.assets]
    .some((claimed) => claimed === path || claimed.startsWith(prefix));
}

function matchesEligibility(candidate: PortfolioCandidate, eligibility: CandidateEligibility): boolean {
  return eligibility === "all" || (eligibility === "eligible" ? candidate.eligible : !candidate.eligible);
}

function compareDetails(left: CandidateDetail, right: CandidateDetail): number {
  return right.score - left.score || byCodeUnit(left.id, right.id);
}
