/** Proven evolution of post-journal generator policy after an extraction. */
import { readFileSync } from "node:fs";
import { relative } from "node:path";

import type { MonocarveConfig } from "../config.ts";
import type { ExtractionManifest, GeneratedFileRecord } from "../plan/manifest.ts";
import { assertPreparerManifest, type PreparerManifest } from "../preparer/index.ts";
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

export function currentGeneratorManifest(options: {
  readonly config: MonocarveConfig;
  readonly configPath: string;
  readonly rootDir: string;
  readonly manifest: ExtractionManifest;
  readonly appliedCommit: string;
}): { readonly manifest: ExtractionManifest; readonly evolutions: readonly GeneratorEvolution[]; readonly failures: readonly string[] } {
  const groups = new Map<string, GeneratedFileRecord[]>();
  for (const record of options.manifest.generatedFiles.filter((item) => item.preparerId !== undefined)) {
    const records = groups.get(record.preparerId!) ?? [];
    records.push(record);
    groups.set(record.preparerId!, records);
  }
  let generatedFiles = [...options.manifest.generatedFiles];
  const evolutions: GeneratorEvolution[] = [];
  const failures: string[] = [];
  for (const [id, records] of groups) {
    const configured = options.config.postJournalPreparers.find((item) => item.id === id);
    if (configured === undefined) {
      failures.push(`post-journal preparer ${id} is absent from current configuration`);
      continue;
    }
    if (configured.command === undefined) {
      failures.push(`post-journal preparer ${id} no longer declares its historical command`);
      continue;
    }
    const command = configured.command;
    const oldOutputs = records.map((item) => item.path).sort();
    const newOutputs = [...configured.outputs].sort();
    const commandMatches = records.every((item) => item.regenerate === configured.command && item.verify === configured.verify);
    if (commandMatches && same(oldOutputs, newOutputs)) continue;
    const evolution = findEvolution({
      ...options,
      command: configured.command,
      ...(configured.verify === undefined ? {} : { verify: configured.verify }),
      outputs: newOutputs,
    });
    if (evolution === undefined) {
      failures.push(`post-journal preparer ${id} differs from the historical manifest without a linked approved preparer transaction`);
      continue;
    }
    const { verify: _historicalVerify, ...template } = records[0]!;
    generatedFiles = generatedFiles.filter((item) => item.preparerId !== id);
    generatedFiles.push(
      ...newOutputs.map((path): GeneratedFileRecord => ({
        ...template,
        path,
        regenerate: command,
        ...(configured.verify === undefined ? {} : { verify: configured.verify }),
      })),
    );
    evolutions.push(evolution);
  }
  return { manifest: { ...options.manifest, generatedFiles }, evolutions, failures };
}

function findEvolution(options: {
  readonly config: MonocarveConfig;
  readonly configPath: string;
  readonly rootDir: string;
  readonly appliedCommit: string;
  readonly command: string;
  readonly verify?: string;
  readonly outputs: readonly string[];
}): GeneratorEvolution | undefined {
  const head = git({ cwd: options.rootDir }, "rev-parse", "HEAD");
  const configPath = relative(options.rootDir, options.configPath).replaceAll("\\", "/");
  const commits = lines(git({ cwd: options.rootDir }, "rev-list", "--reverse", "--first-parent", `${options.appliedCommit}..${head}`));
  for (const [index, commit] of commits.entries()) {
    const parent = git({ cwd: options.rootDir }, "rev-parse", `${commit}^`);
    const changed = lines(git({ cwd: options.rootDir }, "diff-tree", "--no-commit-id", "--name-only", "-r", commit));
    for (const repositoryPath of changed.filter((path) => path.endsWith(".json"))) {
      const path = stripPrefix(options.rootDir, repositoryPath);
      const text = showBaseline(options.rootDir, commit, path);
      if (text === null) continue;
      let candidate: unknown;
      try {
        candidate = JSON.parse(text);
      } catch {
        continue;
      }
      try {
        assertPreparerManifest(options.config, candidate);
      } catch {
        continue;
      }
      const manifest = candidate as PreparerManifest;
      if (
        manifest.baseline.commit !== parent ||
        manifest.bootstrapConfig?.path !== configPath ||
        manifest.preparer.command !== options.command ||
        manifest.preparer.verify !== options.verify
      )
        continue;
      if (hashText(readFileSync(workspacePath(options.rootDir, configPath), "utf8")) !== manifest.bootstrapConfig.resultHash) continue;
      const expectedApprovalPaths = [repositoryPath, `${repositoryPrefix(options.rootDir)}${configPath}`].sort();
      if (!same(changed.sort(), expectedApprovalPaths)) continue;
      const outputCommit = commits[index + 1];
      if (
        outputCommit === undefined ||
        git({ cwd: options.rootDir }, "rev-parse", `${outputCommit}^`) !== commit ||
        git({ cwd: options.rootDir }, "log", "-1", "--format=%s", outputCommit) !== manifest.preparer.commit.subject
      )
        continue;
      const effective = manifest.mutations.filter((item) => item.preconditionHash !== item.resultHash || item.preconditionMode !== item.resultMode);
      const outputPaths = effective.map((item) => `${repositoryPrefix(options.rootDir)}${item.path}`).sort();
      const committedPaths = lines(git({ cwd: options.rootDir }, "diff-tree", "--no-commit-id", "--name-only", "-r", outputCommit)).sort();
      if (!same(outputPaths, committedPaths) || !options.outputs.every((path) => manifest.mutations.some((item) => item.path === path))) continue;
      if (
        effective.some((item) => {
          const bytes = showBaseline(options.rootDir, outputCommit, item.path);
          const tree = git({ cwd: options.rootDir }, "ls-tree", outputCommit, "--", `${repositoryPrefix(options.rootDir)}${item.path}`);
          const mode = Number.parseInt((tree.split(" ")[0] ?? "").slice(-3), 8);
          return bytes === null || hashText(bytes) !== item.resultHash || mode !== item.resultMode;
        })
      )
        continue;
      return { manifestPath: path, approvalCommit: commit, outputCommit, preparerId: manifest.preparer.id, outputs: options.outputs };
    }
  }
  return undefined;
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
