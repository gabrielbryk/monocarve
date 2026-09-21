import { createPackageManagerAdapter, createTaskRunnerAdapter } from "../adapters/registry.ts";
import type { MonocarveConfig } from "../config.ts";
import type { ExtractionManifest } from "../plan/manifest.ts";
import { auditPlanSync } from "./audit.ts";
import { executeJournal, preflightJournal } from "./journal.ts";
import { regenerateArtifacts } from "./regenerate.ts";
import { commitSimulatedExtraction, runGateTiers, type GateResult } from "./simulate.ts";
import { createWorktree, installWorkspaceDependencies, linkPlannedPackage } from "./worktree.ts";
import { statusEntries } from "../util/git.ts";
import { byCodeUnit } from "../util/hash.ts";
import { packageContainerRoots } from "../config.ts";

export interface GateEffect {
  readonly tier: GateResult["tier"];
  readonly command: string;
  readonly exitCode: number;
  readonly changedPaths: readonly string[];
  readonly undeclaredPaths: readonly string[];
  readonly suggestedArtifacts: readonly { path: string; regenerate: string; triggers: readonly string[] }[];
  readonly diagnostic?: GateResult;
}

export interface GateInspectionReport {
  readonly schema: "gate-effects";
  readonly planId: string;
  readonly effects: readonly GateEffect[];
}

/** Run every declared gate in isolation against the landed plan and attribute its writes. */
export async function inspectGateEffects(options: { config: MonocarveConfig; rootDir: string; manifest: ExtractionManifest }): Promise<GateInspectionReport> {
  const { manifest } = options;
  const effects: GateEffect[] = [];
  let index = 0;
  for (const tier of ["package", "project", "workspace"] as const) for (const command of manifest.gates[tier]) {
    effects.push(await inspectOne(options, tier, command, ++index));
  }
  return { schema: "gate-effects", planId: manifest.planId, effects };
}

async function inspectOne(options: { config: MonocarveConfig; rootDir: string; manifest: ExtractionManifest }, tier: GateResult["tier"], command: string, index: number): Promise<GateEffect> {
  const { config, rootDir, manifest } = options;
  const packageManager = createPackageManagerAdapter(config); const taskRunner = createTaskRunnerAdapter(config);
  const worktree = await createWorktree({ rootDir, commit: manifest.baselineCommit, worktreeRoot: config.transaction.worktreeRoot, packageRoots: packageContainerRoots(config), nodeModules: config.transaction.nodeModules, installCommand: packageManager.installCommand(), label: `${manifest.planId}-inspect-${index}` });
  try {
    preflightJournal(config, manifest, worktree.workspacePath);
    await executeJournal({ config, treeRoot: worktree.workspacePath, manifest });
    if (config.transaction.nodeModules === "install") installWorkspaceDependencies(worktree.workspacePath, packageManager.installCommand());
    else if (config.transaction.nodeModules === "symlink") linkPlannedPackage(worktree.workspacePath, manifest);
    const regeneration = regenerateArtifacts({ config, treeRoot: worktree.workspacePath, manifest });
    if (!regeneration.ok) throw new Error(regeneration.failure ?? "artifact regeneration failed");
    const audit = auditPlanSync({ config, rootDir: worktree.workspacePath, manifest, installedRoot: config.transaction.nodeModules === "install" ? worktree.workspacePath : rootDir, regeneratedArtifacts: Object.fromEntries(regeneration.artifacts.map((item) => [item.path, item.hash])) });
    if (!audit.passed) throw new Error(`inspection setup audit failed: ${audit.failures.join("; ")}`);
    commitSimulatedExtraction(worktree.workspacePath, manifest);
    const declared = new Set(manifest.generatedFiles.map((item) => item.path));
    const run = await runGateTiers({ gates: { package: tier === "package" ? [command] : [], project: tier === "project" ? [command] : [], workspace: tier === "workspace" ? [command] : [] }, maxConcurrency: 1, cwd: worktree.workspacePath, timeoutMs: config.gates.timeoutMs, retries: config.transaction.gateRetries, wrapCommand: taskRunner.wrapGateCommand, diagnosticsDirectory: `${worktree.path}.diagnostics` });
    const result = run.results[0]!; const changedPaths = [...new Set(statusEntries(worktree.workspacePath).flatMap((entry) => entry.paths))].sort(byCodeUnit); const undeclaredPaths = changedPaths.filter((path) => !declared.has(path));
    return { tier, command, exitCode: result.exitCode, changedPaths, undeclaredPaths, suggestedArtifacts: undeclaredPaths.map((path) => ({ path, regenerate: command, triggers: [...manifest.changedFiles] })), ...(result.exitCode === 0 ? {} : { diagnostic: result }) };
  } finally { await worktree.dispose(); }
}
