import type { MonocarveConfig } from "../config.ts";
import { MonocarveError, type MonocarveErrorOptions } from "../errors.ts";
import type { ExtractionManifest } from "../plan/manifest.ts";
import type { RepositoryPostconditionReport } from "./postconditions.ts";
import type { GateResult } from "./simulate.ts";

export class ApplyError extends MonocarveError {
  override readonly name = "ApplyError";
  constructor(
    message: string,
    readonly residue: readonly string[] = [],
    options?: MonocarveErrorOptions,
  ) {
    super(message, options);
  }
}

export interface ApplyResult {
  readonly ok: boolean;
  readonly planId: string;
  readonly moveCommit?: string;
  readonly wiringCommit?: string;
  readonly rolledBack: boolean;
  readonly failure?: string;
  readonly dependencyRefresh?: { readonly mode: "install"; readonly command: readonly string[]; readonly completed: true };
  readonly failedGate?: GateResult;
  readonly worktreePath?: string;
  readonly gateRetry?: { readonly cwd: string; readonly command: string };
  readonly repositoryPostconditions?: RepositoryPostconditionReport;
}

export interface ApplyOptions {
  readonly config: MonocarveConfig;
  readonly rootDir: string;
  readonly manifest: ExtractionManifest;
  readonly manifestPath?: string;
  readonly commit?: boolean;
  readonly resume?: boolean;
  readonly skipGates?: boolean;
  readonly skipSimulation?: boolean;
  readonly verifyLockfile?: boolean;
  /** Deterministic fault seams used only by transaction regression tests. */
  readonly testHooks?: {
    readonly beforeRepositoryPostconditions?: () => void;
    /** Awaited after each committed-apply journal operation, before the next one starts. */
    readonly afterJournalOperation?: (index: number) => void | Promise<void>;
  };
}

export type ApplyState = "pre-apply" | "post-move";
