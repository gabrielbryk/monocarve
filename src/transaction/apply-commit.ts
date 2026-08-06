/** Commit construction and exact-scope proofs for a committed apply. */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { fileState } from "../util/files.ts";
import { git, headCommit } from "../util/git.ts";
import { pureRenames, regeneratedArtifactPaths, wiringPaths, type ExtractionManifest, type MoveOperation, type WriteFileOperation } from "../plan/manifest.ts";
import { ApplyError, type ApplyResult, type ApplyState } from "./apply-types.ts";

export function commitAppliedPlan(rootDir: string, manifest: ExtractionManifest, state: ApplyState, onMoveCommitted?: (commit: string) => void): Pick<ApplyResult, "moveCommit" | "wiringCommit"> {
  const moves = pureRenames(manifest);
  const moveCommit = commitMoves(rootDir, manifest, state, moves);
  if (moveCommit !== undefined) onMoveCommitted?.(moveCommit);
  const wiringCommit = commitWiring(rootDir, manifest);
  return { ...(moveCommit === undefined ? {} : { moveCommit }), ...(wiringCommit === undefined ? {} : { wiringCommit }) };
}

function commitMoves(rootDir: string, manifest: ExtractionManifest, state: ApplyState, moves: readonly MoveOperation[]): string | undefined {
  const paths = moves.flatMap((move) => [move.source, move.target]);
  if (state !== "pre-apply" || paths.length === 0) return undefined;
  const compatibility = manifest.modulePromotion?.retireSource === false
    ? manifest.operations.find((operation): operation is WriteFileOperation => operation.kind === "write-file" && operation.path === manifest.modulePromotion?.source && operation.generator === "module-promotion:compatibility-reexport")
    : undefined;
  const compatibilityBytes = compatibility === undefined ? undefined : readFileSync(resolve(rootDir, compatibility.path));
  try {
    if (compatibility !== undefined) rmSync(resolve(rootDir, compatibility.path));
    const stageable = paths.filter((path) => existsSync(resolve(rootDir, path)));
    if (stageable.length > 0) git({ cwd: rootDir, quiet: true }, "add", "-A", "--", ...stageable);
    assertExactMoveDiff(git({ cwd: rootDir }, "diff", "--cached", "--name-status", "--find-renames=100%", "--"), moves, rootDir);
    commitStaged(rootDir, manifest.commits.move.subject, manifest.commits.move.body);
  } finally {
    if (compatibility !== undefined && compatibilityBytes !== undefined) writeFileSync(resolve(rootDir, compatibility.path), compatibilityBytes);
  }
  return headCommit(rootDir);
}

function commitWiring(rootDir: string, manifest: ExtractionManifest): string | undefined {
  const wiring = wiringPaths(manifest);
  if (wiring.length === 0) return undefined;
  git({ cwd: rootDir, quiet: true }, "add", "--", ...wiring);
  assertExactScope(
    git({ cwd: rootDir }, "diff", "--cached", "--name-only", "--").split("\n").filter(Boolean),
    wiring,
    regeneratedArtifactPaths(manifest),
  );
  commitStaged(rootDir, manifest.commits.wiring.subject, manifest.commits.wiring.body);
  return headCommit(rootDir);
}

function commitStaged(rootDir: string, subject: string, body: string | undefined): void {
  const args = ["commit", "--no-verify", "-m", subject];
  if (body) args.push("-m", body);
  git({ cwd: rootDir, quiet: true }, ...args);
}

export function assertExactMoveDiff(diff: string, moves: readonly MoveOperation[], rootDir: string): void {
  const entries = diff.split("\n").filter(Boolean).map((line) => line.split("\t"));
  if (entries.some((entry) => entry[0] !== "R100")) throw new ApplyError("move commit must contain only exact R100 renames");
  const reported = (index: number): string[] => entries.map((entry) => entry[index] ?? "");
  if (!sameMultiset(reported(1), moves.map((move) => move.source)) || !sameMultiset(reported(2), moves.map((move) => move.target))) {
    throw new ApplyError("move commit renames are not exactly the declared move sources and targets");
  }
  for (const move of moves) {
    const landed = fileState(resolve(rootDir, move.target));
    if (landed !== move.resultHash) throw new ApplyError(`moved bytes at ${move.target} do not match the plan: expected ${move.resultHash}, found ${landed}`);
  }
}

function sameMultiset(left: readonly string[], right: readonly string[]): boolean {
  const first = [...left].sort();
  const second = [...right].sort();
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

export function assertExactScope(actual: readonly string[], expected: readonly string[], optional: readonly string[] = []): void {
  const staged = new Set(actual);
  const declared = new Set(expected);
  const skippable = new Set(optional);
  const extra = [...staged].filter((path) => !declared.has(path)).sort();
  if (extra.length > 0) throw new ApplyError(`commit contains files outside the declared operation scope: ${extra.join(", ")}`);
  const absent = [...declared].filter((path) => !staged.has(path) && !skippable.has(path)).sort();
  if (absent.length > 0) throw new ApplyError(`commit is missing declared operation paths: ${absent.join(", ")}`);
}
