/** Commands for config-driven, declared-output pre-extraction transactions. */
import { readFileSync } from "node:fs";

import { flagBool, flagString, type ParsedArgs } from "../cli/args.ts";
import type { MonocarveConfig } from "../config.ts";
import { IoError, UsageError } from "../errors.ts";
import { applyPreparerManifest, assertApprovedPreparerManifest, assertPreparerManifest, commitPreparerOutputs, compilePreparerManifest, serializePreparerManifest, simulatePreparerManifest, type PreparerManifest } from "../preparer/index.ts";
import { currentBranch } from "../util/git.ts";
import { isGuardedBranch } from "../config.ts";
import { relativeWorkspacePath, workspacePath } from "../util/paths.ts";
import type { CommandSpec } from "./types.ts";
import { load, loadManifest, outputPath, print, systemReason, writeOutput } from "./shared.ts";

async function preparerPlan(args: ParsedArgs): Promise<void> {
  const loaded = await load(args);
  const { manifest: extraction } = await loadManifest(withPlan(args, required(args, "extraction")), loaded.rootDir);
  const manifest = await compilePreparerManifest({
    rootDir: loaded.rootDir,
    config: loaded.config,
    extraction,
    preparerId: required(args, "preparer"),
    sourcePath: relativeWorkspacePath(loaded.rootDir, required(args, "source")),
  });
  const out = outputPath(loaded.rootDir, flagString(args, "out") ?? `${loaded.config.planDir}/${manifest.planId}.preparer.json`);
  const written = flagBool(args, "write");
  if (written) writeOutput(loaded.rootDir, out, serializePreparerManifest(manifest), { exclusive: true });
  print({ ...manifest, output: out, written }, args);
}

async function preparerSimulate(args: ParsedArgs): Promise<void> {
  const loaded = await load(args);
  const { path, manifest } = loadPreparerManifest(args, loaded.rootDir, loaded.config);
  await simulatePreparerManifest({ rootDir: loaded.rootDir, config: loaded.config, manifest });
  print({ schema: "preparer-simulation", planId: manifest.planId, manifest: path, ok: true }, args);
}

async function preparerApply(args: ParsedArgs): Promise<void> {
  const loaded = await load(args);
  const { path, manifest } = loadPreparerManifest(args, loaded.rootDir, loaded.config);
  const branch = currentBranch(loaded.rootDir);
  if (isGuardedBranch(loaded.config, branch)) throw new UsageError(`refusing to apply preparer outputs on guarded branch ${branch}`);
  assertApprovedPreparerManifest(loaded.rootDir, path, manifest);
  await simulatePreparerManifest({ rootDir: loaded.rootDir, config: loaded.config, manifest });
  // Verification already passed in the disposable simulation. Never execute a
  // repository-owned command in the real checkout during journal replay.
  applyPreparerManifest({ rootDir: loaded.rootDir, config: loaded.config, manifest, verify: false });
  print({ schema: "preparer-application", planId: manifest.planId, manifest: path, ok: true, committed: false, next: ["preparer-commit", "--plan", path] }, args);
}

async function preparerCommit(args: ParsedArgs): Promise<void> {
  const loaded = await load(args);
  const { path, manifest } = loadPreparerManifest(args, loaded.rootDir, loaded.config);
  const commit = commitPreparerOutputs(loaded.rootDir, loaded.config, path, manifest);
  print({ schema: "preparer-commit", planId: manifest.planId, commit, next: "compile a fresh extraction plan from the new HEAD" }, args);
}

function loadPreparerManifest(args: ParsedArgs, rootDir: string, config: MonocarveConfig): { readonly path: string; readonly manifest: PreparerManifest } {
  const input = flagString(args, "plan") ?? args.positionals[0];
  if (input === undefined) throw new UsageError("a preparer manifest path is required (--plan <path>)");
  const path = relativeWorkspacePath(rootDir, input);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(workspacePath(rootDir, path), "utf8")); }
  catch (error) { throw new IoError(`could not read preparer manifest ${path}: ${systemReason(error)}`); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new UsageError(`preparer manifest ${path} is not a JSON object`);
  assertPreparerManifest(config, parsed);
  return { path, manifest: parsed };
}

function required(args: ParsedArgs, flag: string): string {
  const value = flagString(args, flag);
  if (value === undefined) throw new UsageError(`--${flag} <value> is required`);
  return value;
}

function withPlan(args: ParsedArgs, path: string): ParsedArgs {
  const flags = new Map(args.flags);
  flags.set("plan", path);
  return { ...args, flags };
}

export const preparerCommands: Record<string, CommandSpec> = {
  "preparer-plan": {
    summary: "compile a declared-output pre-extraction transaction",
    usage: "preparer-plan --extraction <path> --preparer <id> --source <path> [--out <path>] [--write]",
    details: "Runs the configured preparer only in a disposable baseline worktree, binds templates to one exact move destination, refuses undeclared repository-visible changes, and optionally writes a separately reviewable manifest. Ignored scratch writes are discarded with the worktree.",
    run: preparerPlan,
  },
  "preparer-simulate": {
    summary: "replay a preparer manifest without changing the checkout",
    usage: "preparer-simulate --plan <path>",
    details: "Replays captured outputs and the configured verification command in a disposable worktree. The invoked checkout remains unchanged.",
    run: preparerSimulate,
  },
  "preparer-apply": {
    summary: "apply a reviewed preparer manifest without committing",
    usage: "preparer-apply --plan <path>",
    details: "Requires the exact manifest as the sole reviewed commit directly above its extraction baseline, simulates first, then journal-applies declared outputs with rollback. It prints the exact preparer-commit argv; committing remains a separate explicit step.",
    run: preparerApply,
  },
  "preparer-commit": {
    summary: "commit exact applied preparer outputs",
    usage: "preparer-commit --plan <path>",
    details: "Requires approved manifest provenance, exact output bytes and modes, and no other dirty paths; commits only declared outputs with the configured subject, then directs a fresh extraction plan.",
    run: preparerCommit,
  },
};
