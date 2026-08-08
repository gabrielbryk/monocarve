import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { MonocarveConfig, PreparerConfig } from "../config.ts";
import { MonocarveError } from "../errors.ts";
import type { ExtractionManifest, MoveOperation } from "../plan/manifest.ts";
import { executePreparationJournal, finalizeCompletedPreparationJournal, rollbackCompletedPreparationJournal } from "../prepare/journal.ts";
import { createPackageManagerAdapter } from "../adapters/registry.ts";
import { createWorktree } from "../transaction/worktree.ts";
import { failedGateOutput } from "../transaction/gate-diagnostics.ts";
import { fileState } from "../util/files.ts";
import { currentBranch, git, headCommit, repositoryPrefix, resolveCommit, scrubbedGitEnv, showBaseline, statusEntries } from "../util/git.ts";
import { isGuardedBranch } from "../config.ts";
import { byCodeUnit, hashBytes, hashJson, hashText, MISSING, stableStringify } from "../util/hash.ts";
import { workspacePath } from "../util/paths.ts";
import { renderTemplate } from "../util/template.ts";
import { PREPARER_MANIFEST_SCHEMA_VERSION, type PreparerManifest, type PreparerMutation } from "./manifest.ts";

export class PreparerError extends MonocarveError { override readonly name = "PreparerError"; }

export interface CompilePreparerInput {
  readonly rootDir: string;
  readonly config: MonocarveConfig;
  readonly extraction: ExtractionManifest;
  readonly preparerId: string;
  /** Selects the reviewed move whose exact source/destination variables render policy. */
  readonly sourcePath: string;
}

export interface CompileStandalonePreparerInput {
  readonly rootDir: string;
  readonly config: MonocarveConfig;
  readonly baselineCommit: string;
  readonly preparerId: string;
  /** Repository-owned policy anchor exposed as both sourcePath and targetPath. */
  readonly sourcePath: string;
}

export async function compilePreparerManifest(input: CompilePreparerInput): Promise<PreparerManifest> {
  const policy = findPolicy(input.config, input.preparerId);
  const move = findMove(input.extraction, input.sourcePath);
  const resolved = resolveCommit(input.rootDir, input.extraction.baselineCommit);
  const vars = variables(input.extraction, move);
  const declaredOutputs = policy.outputs.map((path) => renderTemplate(path, vars)).map((path) => validatedPath(input.rootDir, path));
  const command = policy.command === undefined ? undefined : renderTemplate(policy.command, vars);
  const replacements = policy.replacements?.map((replacement) => ({
    path: validatedPath(input.rootDir, renderTemplate(replacement.path, vars)),
    before: replacement.before,
    after: replacement.after,
    ...(replacement.prefix === undefined ? {} : { prefix: replacement.prefix }),
    ...(replacement.suffix === undefined ? {} : { suffix: replacement.suffix }),
  }));
  const creates = policy.creates?.map((create) => ({
    path: validatedPath(input.rootDir, renderTemplate(create.path, vars)),
    contents: create.contents,
    mode: create.mode ?? 0o644,
  }));
  assertDistinctCreates(creates);
  const createPaths = creates?.map((create) => create.path) ?? [];
  assertNoDuplicatePaths(declaredOutputs, "duplicate declared preparer output path");
  const declaredCreate = createPaths.find((path) => declaredOutputs.includes(path));
  if (declaredCreate !== undefined) throw new PreparerError(`created path is automatically an output and must not be declared twice: ${declaredCreate}`);
  const overlap = replacements?.find((replacement) => createPaths.includes(replacement.path));
  if (overlap !== undefined) throw new PreparerError(`preparer path cannot be both replaced and created: ${overlap.path}`);
  const outputs = unique([...declaredOutputs, ...createPaths]);
  const undeclaredReplacement = replacements?.find((replacement) => !outputs.includes(replacement.path));
  if (undeclaredReplacement !== undefined) throw new PreparerError(`text replacement path is not a declared output: ${undeclaredReplacement.path}`);
  const verify = policy.verify === undefined ? undefined : renderTemplate(policy.verify, vars);
  const adapter = createPackageManagerAdapter(input.config);
  const worktree = await createWorktree({
    rootDir: input.rootDir,
    commit: resolved.commit,
    worktreeRoot: input.config.transaction.worktreeRoot,
    nodeModules: input.config.transaction.nodeModules,
    installCommand: adapter.installCommand(),
    label: `prepare-${policy.id}`,
  });
  try {
    const before = Object.fromEntries(outputs.map((path) => [path, state(worktree.workspacePath, path)]));
    if (replacements !== undefined) applyTextReplacements(worktree.workspacePath, replacements);
    if (creates !== undefined) applyFileCreates(worktree.workspacePath, creates);
    if (command !== undefined) await run(command, worktree.workspacePath, input.config.gates.timeoutMs, "preparer");
    if (verify !== undefined) await run(verify, worktree.workspacePath, input.config.gates.timeoutMs, "preparer verify");
    const changed = unique(statusEntries(worktree.workspacePath).flatMap((entry) => entry.paths)).sort(byCodeUnit);
    const undeclared = changed.filter((path) => !outputs.includes(path));
    if (undeclared.length > 0) throw new PreparerError(`preparer wrote undeclared repository-visible path(s): ${undeclared.join(", ")}`);
    const mutations = outputs.map((path): PreparerMutation => mutation(worktree.workspacePath, path, before[path]!));
    const draft = {
      schemaVersion: PREPARER_MANIFEST_SCHEMA_VERSION,
      createdAt: resolved.committedAt,
      baseline: { commit: resolved.commit, configDigest: hashJson(input.config) },
      extractionPlanId: input.extraction.planId,
      preparer: { id: policy.id, phase: policy.phase, ...(command === undefined ? {} : { command }), ...(replacements === undefined ? {} : { replacements }), ...(creates === undefined ? {} : { creates }), ...(verify === undefined ? {} : { verify }), commit: renderCommit(policy, vars) },
      binding: {
        application: input.extraction.application,
        packageName: input.extraction.target.packageName,
        packageRoot: input.extraction.target.packageRoot,
        sourcePath: move.source,
        targetPath: move.target,
      },
      mutations,
    } as const;
    return { ...draft, planId: hashJson(draft) };
  } finally {
    await worktree.dispose();
  }
}

/** Compile a declared-output preparer that is not coupled to an extraction move. */
export async function compileStandalonePreparerManifest(input: CompileStandalonePreparerInput): Promise<PreparerManifest> {
  const resolved = resolveCommit(input.rootDir, input.baselineCommit);
  const syntheticExtraction = {
    planId: `standalone-${resolved.commit}`,
    baselineCommit: resolved.commit,
    application: "standalone",
    target: { packageName: "standalone", packageRoot: "." },
    operations: [{ kind: "move", source: input.sourcePath, target: input.sourcePath }],
  } as unknown as ExtractionManifest;
  return compilePreparerManifest({
    rootDir: input.rootDir,
    config: input.config,
    extraction: syntheticExtraction,
    preparerId: input.preparerId,
    sourcePath: input.sourcePath,
  });
}

export function serializePreparerManifest(manifest: PreparerManifest): string {
  return `${stableStringify(manifest, 2)}\n`;
}

/**
 * Prove the operator reviewed these exact bytes in a manifest-only commit
 * directly atop the extraction baseline. No subject is prescribed because the
 * preparer policy deliberately has no commit metadata.
 */
export function assertApprovedPreparerManifest(rootDir: string, path: string, manifest: PreparerManifest): void {
  const baseline = manifest.baseline.commit;
  const head = headCommit(rootDir);
  if (head === baseline) throw new PreparerError("preparer manifest must be committed before apply");
  if (git({ cwd: rootDir }, "rev-parse", `${head}^`) !== baseline) {
    throw new PreparerError("approved preparer manifest commit must be directly atop the extraction baseline");
  }
  const changed = git({ cwd: rootDir }, "diff", "--name-only", "--no-renames", `${baseline}..${head}`).split("\n").filter(Boolean);
  const repositoryPath = `${repositoryPrefix(rootDir)}${path}`;
  if (changed.length !== 1 || changed[0] !== repositoryPath) throw new PreparerError("approved preparer commit must contain exactly the manifest");
  const expected = serializePreparerManifest(manifest);
  const loaded = readFileSync(workspacePath(rootDir, path), "utf8");
  if (loaded !== expected || showBaseline(rootDir, head, path) !== expected) {
    throw new PreparerError("loaded preparer manifest bytes do not match the reviewed committed manifest");
  }
}

/** Safely replay captured bytes; a failed verify restores every output. */
export async function applyPreparerManifest(options: {
  readonly rootDir: string;
  readonly config: MonocarveConfig;
  readonly manifest: PreparerManifest;
  readonly verify?: boolean;
}): Promise<void> {
  assertPreparerManifest(options.config, options.manifest);
  const operations = options.manifest.mutations.map((item) => ({ kind: "write" as const, ...item }));
  const journal = executePreparationJournal({ rootDir: options.rootDir, operations });
  try {
    if (options.verify === true && options.manifest.preparer.verify !== undefined) {
      await run(options.manifest.preparer.verify, options.rootDir, options.config.gates.timeoutMs, "preparer verify");
    }
    finalizeCompletedPreparationJournal(journal.recovery);
  } catch (error) {
    const restored = rollbackCompletedPreparationJournal(journal.recovery);
    if (restored.failures.length > 0) throw new PreparerError(`preparer apply failed and rollback was incomplete: ${restored.failures.map((item) => item.path).join(", ")}`);
    throw error;
  }
}

export async function simulatePreparerManifest(options: { readonly rootDir: string; readonly config: MonocarveConfig; readonly manifest: PreparerManifest }): Promise<void> {
  assertPreparerManifest(options.config, options.manifest);
  const adapter = createPackageManagerAdapter(options.config);
  const worktree = await createWorktree({ rootDir: options.rootDir, commit: options.manifest.baseline.commit, worktreeRoot: options.config.transaction.worktreeRoot, nodeModules: options.config.transaction.nodeModules, installCommand: adapter.installCommand(), label: options.manifest.planId });
  try { await applyPreparerManifest({ rootDir: worktree.workspacePath, config: options.config, manifest: options.manifest, verify: true }); }
  finally { await worktree.dispose(); }
}

export function assertPreparerManifest(config: MonocarveConfig, value: unknown): asserts value is PreparerManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new PreparerError("preparer manifest must be a JSON object");
  const manifest = value as Partial<PreparerManifest>;
  if (manifest.schemaVersion !== PREPARER_MANIFEST_SCHEMA_VERSION) throw new PreparerError("unsupported preparer manifest schema");
  if (typeof manifest.planId !== "string" || typeof manifest.extractionPlanId !== "string") throw new PreparerError("preparer manifest identities must be strings");
  if (manifest.baseline === undefined || typeof manifest.baseline.commit !== "string" || typeof manifest.baseline.configDigest !== "string") throw new PreparerError("preparer manifest baseline is invalid");
  if (manifest.preparer === undefined || typeof manifest.preparer.id !== "string") throw new PreparerError("preparer manifest policy is invalid");
  if (manifest.preparer.command !== undefined && typeof manifest.preparer.command !== "string") throw new PreparerError("preparer manifest command is invalid");
  if (manifest.preparer.replacements !== undefined && (!Array.isArray(manifest.preparer.replacements) || manifest.preparer.replacements.some((item) => item === null || typeof item !== "object" || typeof item.path !== "string" || typeof item.before !== "string" || typeof item.after !== "string" || (item.prefix !== undefined && typeof item.prefix !== "string") || (item.suffix !== undefined && typeof item.suffix !== "string")))) throw new PreparerError("preparer manifest replacements are invalid");
  if (manifest.preparer.creates !== undefined && (!Array.isArray(manifest.preparer.creates) || manifest.preparer.creates.some((item) => item === null || typeof item !== "object" || typeof item.path !== "string" || typeof item.contents !== "string" || (item.mode !== 0o644 && item.mode !== 0o755)))) throw new PreparerError("preparer manifest creates are invalid");
  if (manifest.preparer.commit === undefined || typeof manifest.preparer.commit.subject !== "string") throw new PreparerError("preparer manifest commit policy is invalid");
  if (manifest.binding === undefined || Object.values(manifest.binding).some((item) => typeof item !== "string")) throw new PreparerError("preparer manifest move binding is invalid");
  if (!Array.isArray(manifest.mutations) || manifest.mutations.some((item) => item === null || typeof item !== "object" || typeof item.path !== "string" || typeof item.contents !== "string")) throw new PreparerError("preparer manifest mutations are invalid");
  if (manifest.baseline.configDigest !== hashJson(config)) throw new PreparerError("preparer manifest configuration digest mismatch");
  const { planId: _planId, ...draft } = manifest;
  if (manifest.planId !== hashJson(draft)) throw new PreparerError("preparer manifest identity mismatch");
  const policy = findPolicy(config, manifest.preparer.id);
  if (policy.phase !== manifest.preparer.phase) throw new PreparerError("preparer manifest phase differs from configuration");
  const vars = {
    app: manifest.binding.application,
    package: manifest.binding.packageName,
    packageRoot: manifest.binding.packageRoot,
    planId: manifest.extractionPlanId,
    sourcePath: manifest.binding.sourcePath,
    targetPath: manifest.binding.targetPath,
  };
  const expectedCommand = policy.command === undefined ? undefined : renderTemplate(policy.command, vars);
  const expectedReplacements = policy.replacements?.map((replacement) => ({
    path: renderTemplate(replacement.path, vars),
    before: replacement.before,
    after: replacement.after,
    ...(replacement.prefix === undefined ? {} : { prefix: replacement.prefix }),
    ...(replacement.suffix === undefined ? {} : { suffix: replacement.suffix }),
  }));
  const expectedCreates = policy.creates?.map((create) => ({
    path: validatedPath(".", renderTemplate(create.path, vars)),
    contents: create.contents,
    mode: create.mode ?? 0o644,
  }));
  const renderedOutputs = policy.outputs.map((path) => validatedPath(".", renderTemplate(path, vars)));
  assertNoDuplicatePaths(renderedOutputs, "duplicate declared preparer output path");
  const redundantCreateOutput = expectedCreates?.find((create) => renderedOutputs.includes(create.path));
  if (redundantCreateOutput !== undefined) throw new PreparerError(`created path is automatically an output and must not be declared twice: ${redundantCreateOutput.path}`);
  const expectedVerify = policy.verify === undefined ? undefined : renderTemplate(policy.verify, vars);
  const expectedCommit = renderCommit(policy, vars);
  if (manifest.preparer.command !== expectedCommand || !sameOptionalPolicy(manifest.preparer.replacements, expectedReplacements) || !sameOptionalPolicy(manifest.preparer.creates, expectedCreates) || manifest.preparer.verify !== expectedVerify || hashJson(manifest.preparer.commit) !== hashJson(expectedCommit)) {
    throw new PreparerError("preparer manifest commands differ from configuration");
  }
  const expectedOutputs = unique([...renderedOutputs, ...(expectedCreates?.map((create) => create.path) ?? [])]);
  const actualOutputs = manifest.mutations.map((item) => item.path).sort(byCodeUnit);
  if (expectedOutputs.length !== actualOutputs.length || expectedOutputs.some((path, index) => path !== actualOutputs[index])) {
    throw new PreparerError("preparer manifest outputs differ from configuration");
  }
  for (const create of manifest.preparer.creates ?? []) {
    const mutation = manifest.mutations.find((item) => item.path === create.path);
    if (mutation === undefined || mutation.contents !== create.contents || mutation.resultHash !== hashText(create.contents) || mutation.resultMode !== create.mode) {
      throw new PreparerError(`preparer manifest create result differs from policy: ${create.path}`);
    }
    const absent = mutation.preconditionHash === MISSING && mutation.preconditionMode === MISSING;
    const alreadyCreated = mutation.preconditionHash === mutation.resultHash && mutation.preconditionMode === mutation.resultMode;
    if (!absent && !alreadyCreated) throw new PreparerError(`preparer manifest create precondition is neither missing nor exact: ${create.path}`);
  }
}

/** Commit only an already-applied, byte- and mode-exact preparer result. */
export function commitPreparerOutputs(rootDir: string, config: MonocarveConfig, path: string, manifest: PreparerManifest): string {
  assertApprovedPreparerManifest(rootDir, path, manifest);
  const branch = currentBranch(rootDir);
  if (isGuardedBranch(config, branch)) throw new PreparerError(`refusing to commit preparer outputs on guarded branch ${branch}`);
  const declared = manifest.mutations
    .filter((item) => item.preconditionHash !== item.resultHash || item.preconditionMode !== item.resultMode)
    .map((item) => item.path)
    .sort(byCodeUnit);
  if (declared.length === 0) throw new PreparerError("preparer output commit has no effective mutations");
  for (const item of manifest.mutations) {
    const actual = state(rootDir, item.path);
    if (actual.hash !== item.resultHash || actual.mode !== item.resultMode) throw new PreparerError(`applied preparer output differs from reviewed result: ${item.path}`);
  }
  const dirty = unique(statusEntries(rootDir).flatMap((entry) => entry.paths)).sort(byCodeUnit);
  if (dirty.length !== declared.length || dirty.some((item, index) => item !== declared[index])) {
    throw new PreparerError(`preparer output commit requires exactly the declared dirty paths; found: ${dirty.join(", ") || "(none)"}`);
  }
  git({ cwd: rootDir, quiet: true }, "add", "--", ...declared);
  const commit = manifest.preparer.commit;
  try {
    git({ cwd: rootDir, quiet: true }, "-c", "core.hooksPath=/dev/null", "commit", "-m", commit.subject, ...(commit.body === undefined ? [] : ["-m", commit.body]), "--", ...declared);
  } catch (error) {
    git({ cwd: rootDir, quiet: true }, "reset", "--", ...declared);
    throw error;
  }
  const result = headCommit(rootDir);
  const committed = git({ cwd: rootDir }, "diff-tree", "--no-commit-id", "--name-only", "-r", result).split("\n").filter(Boolean).sort(byCodeUnit);
  const expected = declared.map((item) => `${repositoryPrefix(rootDir)}${item}`).sort(byCodeUnit);
  if (committed.length !== expected.length || committed.some((item, index) => item !== expected[index])) throw new PreparerError("preparer output commit path verification failed");
  for (const item of manifest.mutations) {
    const blob = showBaseline(rootDir, result, item.path);
    const tree = git({ cwd: rootDir }, "ls-tree", result, "--", `${repositoryPrefix(rootDir)}${item.path}`);
    const committedMode = Number.parseInt((tree.split(" ")[0] ?? "").slice(-3), 8);
    if (blob === null || hashText(blob) !== item.resultHash || committedMode !== item.resultMode) throw new PreparerError(`preparer output commit proof failed: ${item.path}`);
  }
  return result;
}

function mutation(root: string, path: string, before: ReturnType<typeof state>): PreparerMutation {
  const absolute = workspacePath(root, path);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new PreparerError(`declared preparer output is not a file: ${path}`);
  const bytes = readFileSync(absolute);
  const contents = bytes.toString("utf8");
  if (hashText(contents) !== hashBytes(bytes)) throw new PreparerError(`declared preparer output is not UTF-8 text: ${path}`);
  const mode = canonicalMode(statSync(absolute).mode);
  return { path, preconditionHash: before.hash, preconditionMode: before.mode, resultHash: hashBytes(bytes), resultMode: mode, contents };
}

function state(root: string, path: string): { readonly hash: ReturnType<typeof fileState>; readonly mode: number | "missing" } {
  const absolute = workspacePath(root, path);
  return existsSync(absolute) ? { hash: fileState(absolute), mode: canonicalMode(statSync(absolute).mode) } : { hash: MISSING, mode: MISSING };
}

function canonicalMode(mode: number): 0o644 | 0o755 { return (mode & 0o111) === 0 ? 0o644 : 0o755; }

function findPolicy(config: MonocarveConfig, id: string): PreparerConfig {
  const policy = config.preparers.find((item) => item.id === id);
  if (!policy) throw new PreparerError(`unknown configured preparer: ${id}`);
  return policy;
}

function findMove(manifest: ExtractionManifest, source: string): MoveOperation {
  const matches = manifest.operations.filter((operation): operation is MoveOperation => operation.kind === "move" && operation.source === source);
  if (matches.length !== 1) throw new PreparerError(`expected one byte-identical move for source path: ${source}`);
  return matches[0]!;
}

function variables(manifest: ExtractionManifest, move: MoveOperation): Readonly<Record<string, string>> {
  return { app: manifest.application, package: manifest.target.packageName, packageRoot: manifest.target.packageRoot, planId: manifest.planId, sourcePath: move.source, targetPath: move.target };
}

function renderCommit(policy: PreparerConfig, vars: Readonly<Record<string, string>>): { readonly subject: string; readonly body?: string } {
  return { subject: renderTemplate(policy.commit.subject, vars), ...(policy.commit.body === undefined ? {} : { body: renderTemplate(policy.commit.body, vars) }) };
}

function validatedPath(root: string, path: string): string { workspacePath(root, path); return path.replaceAll("\\", "/"); }
function unique(items: readonly string[]): string[] { return [...new Set(items)].sort(byCodeUnit); }

type TextReplacement = { readonly path: string; readonly before: string; readonly after: string; readonly prefix?: string; readonly suffix?: string };
type FileCreate = { readonly path: string; readonly contents: string; readonly mode: 0o644 | 0o755 };

function assertDistinctCreates(creates: readonly FileCreate[] | undefined): void {
  if (creates === undefined) return;
  const seen = new Set<string>();
  for (const create of creates) {
    if (seen.has(create.path)) throw new PreparerError(`duplicate preparer create path: ${create.path}`);
    seen.add(create.path);
  }
}

function assertNoDuplicatePaths(paths: readonly string[], message: string): void {
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) throw new PreparerError(`${message}: ${path}`);
    seen.add(path);
  }
}

function applyFileCreates(root: string, creates: readonly FileCreate[]): void {
  for (const [index, create] of creates.entries()) {
    const absolute = workspacePath(root, create.path);
    if (existsSync(absolute)) {
      if (!statSync(absolute).isFile()) throw new PreparerError(`file create ${index + 1} path is not a file: ${create.path}`);
      const bytes = readFileSync(absolute);
      const mode = canonicalMode(statSync(absolute).mode);
      if (hashBytes(bytes) !== hashText(create.contents) || mode !== create.mode) {
        throw new PreparerError(`file create ${index + 1} found different existing content or mode: ${create.path}`);
      }
      continue;
    }
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, create.contents, { mode: create.mode });
    chmodSync(absolute, create.mode);
  }
}

function applyTextReplacements(root: string, replacements: readonly TextReplacement[]): void {
  for (const [index, replacement] of replacements.entries()) {
    const absolute = workspacePath(root, replacement.path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new PreparerError(`text replacement ${index + 1} path is not a file: ${replacement.path}`);
    const contents = readFileSync(absolute, "utf8");
    const beforeState = framed(replacement, replacement.before);
    const afterState = framed(replacement, replacement.after);
    const first = contents.indexOf(beforeState);
    if (first >= 0) {
      if (contents.indexOf(beforeState, first + beforeState.length) >= 0) throw new PreparerError(`text replacement ${index + 1} before text is ambiguous in ${replacement.path}`);
      writeFileSync(absolute, `${contents.slice(0, first)}${afterState}${contents.slice(first + beforeState.length)}`);
      continue;
    }
    const terminalState = terminalReplacementAfter(replacements, index);
    if (uniqueOccurrence(contents, afterState) || uniqueOccurrence(contents, terminalState)) continue;
    throw new PreparerError(`text replacement ${index + 1} matched neither before nor after text in ${replacement.path}`);
  }
}

function terminalReplacementAfter(replacements: readonly TextReplacement[], index: number): string {
  const current = replacements[index]!;
  let terminal = current.after;
  for (const candidate of replacements.slice(index + 1)) {
    if (candidate.path === current.path && candidate.prefix === current.prefix && candidate.suffix === current.suffix && candidate.before === terminal) terminal = candidate.after;
  }
  return framed(current, terminal);
}

function framed(replacement: Pick<TextReplacement, "prefix" | "suffix">, text: string): string { return `${replacement.prefix ?? ""}${text}${replacement.suffix ?? ""}`; }
function uniqueOccurrence(contents: string, state: string): boolean {
  const first = contents.indexOf(state);
  return first >= 0 && contents.indexOf(state, first + state.length) < 0;
}

function sameOptionalPolicy(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return hashJson(left) === hashJson(right);
}

async function run(command: string, cwd: string, timeout: number, label: string): Promise<void> {
  // Drain both streams while the process tree runs. Bun.spawnSync's buffered
  // pipes can terminate the invoking CLI without returning to JavaScript when
  // a nested repository gate produces sustained output. The async boundary is
  // also explicit about stdin: repository verification is non-interactive and
  // must never consume the operator CLI's input stream.
  const child = Bun.spawn(["sh", "-c", command], {
    cwd,
    env: scrubbedGitEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeout);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    captureProcessStream(child.stdout),
    captureProcessStream(child.stderr),
  ]).finally(() => clearTimeout(timer));
  if (exitCode !== 0 || timedOut) {
    const output = failedGateOutput({ stdout, stderr }).trim();
    const reason = timedOut ? `timed out after ${timeout}ms` : `failed (exit ${exitCode})`;
    throw new PreparerError(`${label} command ${reason}${output ? `:\n${output}` : ""}`);
  }
}

/** Drain a child stream completely while retaining only bounded diagnostics. */
async function captureProcessStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const limit = 16_000;
  const marker = "\n… process output omitted …\n";
  const head = 4_000;
  const tail = limit - head - marker.length;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
    if (output.length > limit) output = `${output.slice(0, head)}${marker}${output.slice(-tail)}`;
  }
  output += decoder.decode();
  return output.length <= limit ? output : `${output.slice(0, head)}${marker}${output.slice(-tail)}`;
}
