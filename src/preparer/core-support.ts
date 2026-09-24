// Small, purely structural helpers shared by preparer compilation and
// validation (core-compile.ts and core-validate.ts) plus core.ts itself.
// Extracted from core.ts to keep each caller's own control flow small; every
// function here is a direct behavior-preserving lift of code that used to
// live inline, so none of it changes what gets computed.
import { existsSync, readFileSync, statSync } from "node:fs";

import { triggeredArtifacts, type MonocarveConfig, type PreparerConfig } from "../config.ts";
import type { ExtractionManifest, MoveOperation } from "../plan/manifest.ts";
import { fileState } from "../util/files.ts";
import { git, repositoryPrefix, showBaseline, showBaselineBytes } from "../util/git.ts";
import { byCodeUnit, hashBytes, hashJson, hashText, MISSING } from "../util/hash.ts";
import { workspacePath } from "../util/paths.ts";
import { renderTemplate } from "../util/template.ts";
import type { FileCreate, TextReplacement } from "./declarative.ts";
import { PreparerError } from "./error.ts";
import type { PreparerMutation } from "./manifest.ts";

export function unique(items: readonly string[]): string[] {
  return [...new Set(items)].sort(byCodeUnit);
}
export function validatedPath(root: string, path: string): string {
  workspacePath(root, path);
  return path.replaceAll("\\", "/");
}

export function assertDistinctCreates(creates: readonly FileCreate[] | undefined): void {
  if (creates === undefined) return;
  const seen = new Set<string>();
  for (const create of creates) {
    if (seen.has(create.path)) throw new PreparerError(`duplicate preparer create path: ${create.path}`);
    seen.add(create.path);
  }
}

export function assertNoDuplicatePaths(paths: readonly string[], message: string): void {
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) throw new PreparerError(`${message}: ${path}`);
    seen.add(path);
  }
}

export function sameOptionalPolicy(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return hashJson(left) === hashJson(right);
}

export function findPolicy(config: MonocarveConfig, id: string): PreparerConfig {
  const policy = config.preparers.find((item) => item.id === id);
  if (!policy) throw new PreparerError(`unknown configured preparer: ${id}`);
  return policy;
}

export function findMove(manifest: ExtractionManifest, source: string): MoveOperation {
  const matches = manifest.operations.filter((operation): operation is MoveOperation => operation.kind === "move" && operation.source === source);
  if (matches.length !== 1) throw new PreparerError(`expected one byte-identical move for source path: ${source}`);
  return matches[0]!;
}

export function variables(manifest: ExtractionManifest, move: MoveOperation): Readonly<Record<string, string>> {
  return {
    app: manifest.application,
    package: manifest.target.packageName,
    packageRoot: manifest.target.packageRoot,
    planId: manifest.planId,
    sourcePath: move.source,
    targetPath: move.target,
  };
}

export function renderCommit(policy: PreparerConfig, vars: Readonly<Record<string, string>>): { readonly subject: string; readonly body?: string } {
  return {
    subject: renderTemplate(policy.commit.subject, vars),
    ...(policy.commit.body === undefined ? {} : { body: renderTemplate(policy.commit.body, vars) }),
  };
}

/** Render and normalize a policy's declared output paths; `mapPath` carries the caller-specific root used to validate them. */
export function expandDeclaredOutputs(
  policy: Pick<PreparerConfig, "outputs">,
  vars: Readonly<Record<string, string>>,
  mapPath: (path: string) => string,
): string[] {
  return policy.outputs.map((path) => mapPath(renderTemplate(path, vars)));
}

/** Render a policy's text replacements; `mapPath` carries the caller-specific path normalization (or none). */
export function expandReplacementsPolicy(
  replacements: PreparerConfig["replacements"],
  vars: Readonly<Record<string, string>>,
  mapPath: (path: string) => string,
): TextReplacement[] | undefined {
  return replacements?.map((replacement) => ({
    path: mapPath(renderTemplate(replacement.path, vars)),
    before: replacement.before,
    after: replacement.after,
    ...(replacement.prefix === undefined ? {} : { prefix: replacement.prefix }),
    ...(replacement.suffix === undefined ? {} : { suffix: replacement.suffix }),
  }));
}

/** Render a policy's declared file creates against the given root. */
export function expandCreatesPolicy(root: string, creates: PreparerConfig["creates"], vars: Readonly<Record<string, string>>): FileCreate[] | undefined {
  return creates?.map((create) => ({ path: validatedPath(root, renderTemplate(create.path, vars)), contents: create.contents, mode: create.mode ?? 0o644 }));
}

/** Expand a preparer's effective mutation paths into the generated artifacts they trigger. */
export function expandGeneratedArtifacts(config: MonocarveConfig, triggerPaths: readonly string[]) {
  return triggeredArtifacts(config, triggerPaths)
    .map((artifact) => ({
      path: artifact.path,
      source: artifact.source,
      regenerate: artifact.regenerate,
      regenerateOnApply: true as const,
      ...(artifact.exemptReason === undefined ? {} : { exemptReason: artifact.exemptReason }),
    }))
    .sort((left, right) => byCodeUnit(left.path, right.path));
}

export function canonicalMode(mode: number): 0o644 | 0o755 {
  return (mode & 0o111) === 0 ? 0o644 : 0o755;
}

export function state(root: string, path: string): { readonly hash: ReturnType<typeof fileState>; readonly mode: number | "missing" } {
  const absolute = workspacePath(root, path);
  return existsSync(absolute) ? { hash: fileState(absolute), mode: canonicalMode(statSync(absolute).mode) } : { hash: MISSING, mode: MISSING };
}

export function baselineState(root: string, commit: string, path: string): { readonly hash: ReturnType<typeof fileState>; readonly mode: number | "missing" } {
  const bytes = showBaselineBytes(root, commit, path);
  if (bytes === null) return { hash: MISSING, mode: MISSING };
  const tree = git({ cwd: root }, "ls-tree", commit, "--", `${repositoryPrefix(root)}${path}`);
  const mode = tree.split(" ")[0];
  return { hash: hashBytes(bytes), mode: mode === "100755" ? 0o755 : 0o644 };
}

/** Every mutation's declared result must match the filesystem exactly. */
export function assertMutationsMatchState(root: string, mutations: readonly PreparerMutation[]): void {
  for (const item of mutations) {
    const actual = state(root, item.path);
    if (actual.hash !== item.resultHash || actual.mode !== item.resultMode)
      throw new PreparerError(`applied preparer output differs from reviewed result: ${item.path}`);
  }
}

/** Every mutation's declared result must match the exact blob and mode committed at `result`. */
export function assertCommittedMutationsMatch(rootDir: string, result: string, mutations: readonly PreparerMutation[]): void {
  for (const item of mutations) {
    const blob = showBaseline(rootDir, result, item.path);
    const tree = git({ cwd: rootDir }, "ls-tree", result, "--", `${repositoryPrefix(rootDir)}${item.path}`);
    const committedMode = Number.parseInt((tree.split(" ")[0] ?? "").slice(-3), 8);
    if (blob === null || hashText(blob) !== item.resultHash || committedMode !== item.resultMode)
      throw new PreparerError(`preparer output commit proof failed: ${item.path}`);
  }
}

export function mutation(root: string, path: string, before: ReturnType<typeof state>): PreparerMutation {
  const absolute = workspacePath(root, path);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new PreparerError(`declared preparer output is not a file: ${path}`);
  const bytes = readFileSync(absolute);
  const contents = bytes.toString("utf8");
  if (hashText(contents) !== hashBytes(bytes)) throw new PreparerError(`declared preparer output is not UTF-8 text: ${path}`);
  const mode = canonicalMode(statSync(absolute).mode);
  return { path, preconditionHash: before.hash, preconditionMode: before.mode, resultHash: hashBytes(bytes), resultMode: mode, contents };
}
