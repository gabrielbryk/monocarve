/** Proven evolution of post-journal generator policy after an extraction. */
import { readFileSync } from "node:fs";
import { relative } from "node:path";

import type { MonocarveConfig } from "../config.ts";
import type { ExtractionManifest, GeneratedFileRecord } from "../plan/manifest.ts";
import { assertPreparerManifest } from "../preparer/core-validate.ts";
import type { PreparerManifest } from "../preparer/manifest.ts";
import { git, repositoryPrefix, showBaseline } from "../util/git.ts";
import { hashText } from "../util/hash.ts";
import { workspacePath } from "../util/paths.ts";

export interface GeneratorEvolution {
  readonly manifestPath: string;
  readonly approvalCommit: string;
  readonly outputCommit: string;
  readonly preparerId: string;
  readonly outputs: readonly string[];
}

interface CurrentGeneratorOptions {
  readonly config: MonocarveConfig;
  readonly configPath: string;
  readonly rootDir: string;
  readonly manifest: ExtractionManifest;
  readonly appliedCommit: string;
}

export function currentGeneratorManifest(options: CurrentGeneratorOptions): {
  readonly manifest: ExtractionManifest;
  readonly evolutions: readonly GeneratorEvolution[];
  readonly failures: readonly string[];
} {
  let generatedFiles = [...options.manifest.generatedFiles];
  const evolutions: GeneratorEvolution[] = [];
  const failures: string[] = [];
  for (const [id, records] of groupByPreparer(options.manifest.generatedFiles)) {
    const result = evolvePreparerGroup(options, id, records);
    if (result === undefined) continue;
    if ("failure" in result) {
      failures.push(result.failure);
      continue;
    }
    generatedFiles = generatedFiles.filter((item) => item.preparerId !== id);
    generatedFiles.push(...result.records);
    evolutions.push(result.evolution);
  }
  return { manifest: { ...options.manifest, generatedFiles }, evolutions, failures };
}

function groupByPreparer(generatedFiles: readonly GeneratedFileRecord[]): Map<string, GeneratedFileRecord[]> {
  const groups = new Map<string, GeneratedFileRecord[]>();
  for (const record of generatedFiles.filter((item) => item.preparerId !== undefined)) {
    const records = groups.get(record.preparerId!) ?? [];
    records.push(record);
    groups.set(record.preparerId!, records);
  }
  return groups;
}

/** Undefined when the preparer is unchanged; otherwise its replacement records, or why none is proven. */
type GroupEvolution = { readonly failure: string } | { readonly evolution: GeneratorEvolution; readonly records: readonly GeneratedFileRecord[] } | undefined;

function evolvePreparerGroup(options: CurrentGeneratorOptions, id: string, records: readonly GeneratedFileRecord[]): GroupEvolution {
  const configured = options.config.postJournalPreparers.find((item) => item.id === id);
  if (configured === undefined) return { failure: `post-journal preparer ${id} is absent from current configuration` };
  if (configured.command === undefined) return { failure: `post-journal preparer ${id} no longer declares its historical command` };
  const command = configured.command;
  const oldOutputs = records.map((item) => item.path).toSorted();
  const newOutputs = [...configured.outputs].toSorted();
  const commandMatches = records.every((item) => item.regenerate === configured.command && item.verify === configured.verify);
  if (commandMatches && same(oldOutputs, newOutputs)) return undefined;
  const evolution = findEvolution({
    ...options,
    command: configured.command,
    ...(configured.verify === undefined ? {} : { verify: configured.verify }),
    outputs: newOutputs,
  });
  if (evolution === undefined)
    return { failure: `post-journal preparer ${id} differs from the historical manifest without a linked approved preparer transaction` };
  const { verify: _historicalVerify, ...template } = records[0]!;
  return {
    evolution,
    records: newOutputs.map((path): GeneratedFileRecord => ({
      ...template,
      path,
      regenerate: command,
      ...(configured.verify === undefined ? {} : { verify: configured.verify }),
    })),
  };
}

interface EvolutionSearch {
  readonly config: MonocarveConfig;
  readonly configPath: string;
  readonly rootDir: string;
  readonly appliedCommit: string;
  readonly command: string;
  readonly verify?: string;
  readonly outputs: readonly string[];
}

/** One candidate approval manifest, in the first-parent history after the applied commit. */
interface ApprovalCandidate {
  /** Config path relative to the workspace root. */
  readonly configPath: string;
  readonly commits: readonly string[];
  readonly index: number;
  readonly commit: string;
  readonly parent: string;
  /** Every path the approval commit changed; sorted in place when compared. */
  readonly changed: string[];
  readonly repositoryPath: string;
}

type PreparerMutation = PreparerManifest["mutations"][number];

function findEvolution(options: EvolutionSearch): GeneratorEvolution | undefined {
  const head = git({ cwd: options.rootDir }, "rev-parse", "HEAD");
  const configPath = relative(options.rootDir, options.configPath).replaceAll("\\", "/");
  const commits = lines(git({ cwd: options.rootDir }, "rev-list", "--reverse", "--first-parent", `${options.appliedCommit}..${head}`));
  for (const [index, commit] of commits.entries()) {
    const parent = git({ cwd: options.rootDir }, "rev-parse", `${commit}^`);
    const changed = lines(git({ cwd: options.rootDir }, "diff-tree", "--no-commit-id", "--name-only", "-r", commit));
    for (const repositoryPath of changed.filter((path) => path.endsWith(".json"))) {
      const evolution = approvedEvolution(options, { configPath, commits, index, commit, parent, changed, repositoryPath });
      if (evolution !== undefined) return evolution;
    }
  }
  return undefined;
}

function approvedEvolution(options: EvolutionSearch, candidate: ApprovalCandidate): GeneratorEvolution | undefined {
  const path = stripPrefix(options.rootDir, candidate.repositoryPath);
  const manifest = readPreparerManifest(options, candidate.commit, path);
  if (manifest === undefined || !approvalMatches(options, candidate, manifest)) return undefined;
  const outputCommit = candidate.commits[candidate.index + 1];
  if (outputCommit === undefined || !outputCommitMatches(options, candidate.commit, outputCommit, manifest)) return undefined;
  return { manifestPath: path, approvalCommit: candidate.commit, outputCommit, preparerId: manifest.preparer.id, outputs: options.outputs };
}

/** A valid preparer manifest at `commit`, or undefined for anything else (absent, not JSON, not a manifest). */
function readPreparerManifest(options: EvolutionSearch, commit: string, path: string): PreparerManifest | undefined {
  const text = showBaseline(options.rootDir, commit, path);
  if (text === null) return undefined;
  let candidate: unknown;
  try {
    candidate = JSON.parse(text);
  } catch {
    return undefined;
  }
  try {
    assertPreparerManifest(options.config, candidate);
  } catch {
    return undefined;
  }
  return candidate as PreparerManifest;
}

/** The approval commit carries exactly this manifest and the config it bootstraps, for the configured command. */
function approvalMatches(options: EvolutionSearch, candidate: ApprovalCandidate, manifest: PreparerManifest): boolean {
  if (
    manifest.baseline.commit !== candidate.parent ||
    manifest.bootstrapConfig?.path !== candidate.configPath ||
    manifest.preparer.command !== options.command ||
    manifest.preparer.verify !== options.verify
  )
    return false;
  if (hashText(readFileSync(workspacePath(options.rootDir, candidate.configPath), "utf8")) !== manifest.bootstrapConfig.resultHash) return false;
  const expectedApprovalPaths = [candidate.repositoryPath, `${repositoryPrefix(options.rootDir)}${candidate.configPath}`].toSorted();
  return same(candidate.changed.sort(), expectedApprovalPaths);
}

/** The next first-parent commit is the preparer's output commit and lands exactly the manifest's effective mutations. */
function outputCommitMatches(options: EvolutionSearch, approvalCommit: string, outputCommit: string, manifest: PreparerManifest): boolean {
  if (
    git({ cwd: options.rootDir }, "rev-parse", `${outputCommit}^`) !== approvalCommit ||
    git({ cwd: options.rootDir }, "log", "-1", "--format=%s", outputCommit) !== manifest.preparer.commit.subject
  )
    return false;
  const effective = manifest.mutations.filter((item) => item.preconditionHash !== item.resultHash || item.preconditionMode !== item.resultMode);
  const outputPaths = effective.map((item) => `${repositoryPrefix(options.rootDir)}${item.path}`).toSorted();
  const committedPaths = lines(git({ cwd: options.rootDir }, "diff-tree", "--no-commit-id", "--name-only", "-r", outputCommit)).sort();
  if (!same(outputPaths, committedPaths) || !options.outputs.every((path) => manifest.mutations.some((item) => item.path === path))) return false;
  return !effective.some((item) => mutationDiffers(options.rootDir, outputCommit, item));
}

function mutationDiffers(rootDir: string, outputCommit: string, item: PreparerMutation): boolean {
  const bytes = showBaseline(rootDir, outputCommit, item.path);
  const tree = git({ cwd: rootDir }, "ls-tree", outputCommit, "--", `${repositoryPrefix(rootDir)}${item.path}`);
  const mode = Number.parseInt((tree.split(" ")[0] ?? "").slice(-3), 8);
  return bytes === null || hashText(bytes) !== item.resultHash || mode !== item.resultMode;
}

function stripPrefix(rootDir: string, path: string): string {
  const prefix = repositoryPrefix(rootDir);
  return prefix === "" ? path : path.slice(prefix.length);
}
function lines(value: string): string[] {
  return value.split("\n").filter(Boolean);
}
function same(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
