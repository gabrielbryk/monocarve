/**
 * The gate-tier scheduler, split out of `simulate.ts` purely to keep that file
 * under the line-count gate: this half owns nothing about worktrees, plans, or
 * manifests — only "run these shell commands, tier by tier, with bounded
 * concurrency and declared-order results." `simulate.ts` still owns the
 * `GateResult`/`GateCommandRunner` types and the diagnostics-plumbing default
 * runner call site; this module just executes against them.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ExtractionManifest } from "../plan/manifest.ts";
import { completeGateOutput, diagnosticExcerpts, failedGateOutput, persistDiagnostic } from "./gate-diagnostics.ts";
import type { GateCommandOutput, GateCommandRunner, GateResult } from "./simulate.ts";

export interface GateTierRun {
  readonly results: readonly GateResult[];
  /** First failure by declared tier and command order, never completion order. */
  readonly failure?: GateResult;
}

export interface GateTierOptions {
  readonly gates: ExtractionManifest["gates"];
  readonly maxConcurrency: number;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly retries?: number;
  readonly wrapCommand: (command: string) => readonly string[];
  readonly runner?: GateCommandRunner;
  /** Outside the gated workspace; callers normally use a worktree sibling. */
  readonly diagnosticsDirectory?: string;
  /** Injectable only so a failed diagnostic write has a negative proof. */
  readonly writeDiagnostic?: (path: string, contents: string) => void;
}

/** Run tiers serially; within a tier preserve declaration order, not completion order. */
export async function runGateTiers(options: GateTierOptions): Promise<GateTierRun> {
  const results: GateResult[] = [];
  const runner = options.runner ?? runBunGateCommand;
  for (const tier of ["package", "project", "workspace"] as const) {
    if (options.gates[tier].length === 0) continue;
    const tierResults = await runGateTier({
      commands: options.gates[tier],
      tier,
      maxConcurrency: options.maxConcurrency,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      retries: options.retries ?? 0,
      wrapCommand: options.wrapCommand,
      runner,
      ...(options.diagnosticsDirectory === undefined ? {} : { diagnosticsDirectory: options.diagnosticsDirectory }),
      ...(options.writeDiagnostic === undefined ? {} : { writeDiagnostic: options.writeDiagnostic }),
    });
    results.push(...tierResults);
    const failure = tierResults.find((result) => result.exitCode !== 0);
    if (failure) return { results, failure };
  }
  return { results };
}

interface SingleTierOptions {
  readonly commands: readonly string[];
  readonly tier: GateResult["tier"];
  readonly maxConcurrency: number;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly wrapCommand: (command: string) => readonly string[];
  readonly runner: GateCommandRunner;
  readonly diagnosticsDirectory?: string;
  readonly writeDiagnostic?: (path: string, contents: string) => void;
}

async function runGateTier(options: SingleTierOptions): Promise<readonly GateResult[]> {
  const results: Array<GateResult | undefined> = new Array(options.commands.length);
  let nextIndex = 0;
  let failureObserved = false;
  const worker = async (): Promise<void> => {
    while (!failureObserved && nextIndex < options.commands.length) {
      const index = nextIndex;
      nextIndex += 1;
      const command = options.commands[index]!;
      const result = await runGate(
        options.wrapCommand(command),
        command,
        options.tier,
        options.cwd,
        options.timeoutMs,
        options.retries,
        options.runner,
        options.diagnosticsDirectory === undefined ? undefined : join(options.diagnosticsDirectory, `${options.tier}-${index + 1}.log`),
        options.writeDiagnostic,
      );
      results[index] = result;
      // Do not admit another command after a failure. Other workers may still
      // hold admitted commands; Promise.all below deliberately waits for them
      // so their declared-order results remain available for diagnosis.
      if (result.exitCode !== 0) failureObserved = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.maxConcurrency, options.commands.length) }, worker));
  return results.filter((result): result is GateResult => result !== undefined);
}

async function runGate(
  command: readonly string[],
  original: string,
  tier: GateResult["tier"],
  cwd: string,
  timeoutMs: number,
  retries: number,
  runner: GateCommandRunner,
  diagnosticPath?: string,
  writeDiagnostic: (path: string, contents: string) => void = persistDiagnostic,
): Promise<GateResult> {
  const started = Date.now();
  const attempts: { exitCode: number; durationMs: number; output?: string }[] = [];
  let result: GateCommandOutput;
  for (let attempt = 0; ; attempt += 1) {
    const attemptStarted = Date.now();
    result = await runner(command, { cwd, timeoutMs });
    attempts.push({
      exitCode: result.exitCode,
      durationMs: Date.now() - attemptStarted,
      ...(result.exitCode === 0 ? {} : { output: failedGateOutput(result) }),
    });
    if (result.exitCode === 0 || attempt >= retries) break;
  }
  const exitCode = result.exitCode;
  if (exitCode === 0) return { command: original, tier, exitCode, durationMs: Date.now() - started, ...(attempts.length === 1 ? {} : { attempts }) };
  const completeOutput = completeGateOutput(result);
  const output = failedGateOutput(result);
  const { head: outputHead, tail: outputTail } = diagnosticExcerpts(completeOutput);
  let logPath: string | undefined;
  let logWriteFailure: string | undefined;
  if (diagnosticPath !== undefined) {
    try {
      writeDiagnostic(diagnosticPath, completeOutput);
      logPath = diagnosticPath;
    } catch (error) {
      logWriteFailure = (error as Error).message;
    }
  }
  return {
    command: original,
    tier,
    exitCode,
    durationMs: Date.now() - started,
    output,
    outputHead,
    outputTail,
    ...(logPath === undefined ? {} : { logPath }),
    ...(logWriteFailure === undefined ? {} : { logWriteFailure }),
    ...(attempts.length === 1 ? {} : { attempts }),
  };
}

async function runBunGateCommand(command: readonly string[], options: { readonly cwd: string; readonly timeoutMs: number }): Promise<GateCommandOutput> {
  // Keep compiler/test scratch off system /tmp: on long campaigns its tmpfs
  // can exhaust inodes while the disposable worktree's backing disk is fine.
  // A unique directory per command is concurrency-safe and is always removed.
  const gateTemp = mkdtempSync(join(dirname(options.cwd), ".monocarve-gate-tmp-"));
  try {
    const child = Bun.spawn([...command], {
      cwd: options.cwd,
      // Package-manager shims may otherwise prompt before repairing a
      // worktree's dependency layout, which makes isolated gates fail with a
      // TTY-only error instead of testing the plan.
      env: { ...process.env, CI: "true", TMPDIR: gateTemp, TEMP: gateTemp, TMP: gateTemp },
      stdout: "pipe",
      stderr: "pipe",
      timeout: options.timeoutMs,
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exitCode, stdout, stderr };
  } finally {
    rmSync(gateTemp, { recursive: true, force: true });
  }
}
