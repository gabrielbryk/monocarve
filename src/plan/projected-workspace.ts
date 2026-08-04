/** Projected structured workspace state used while compiling a plan. */

import type { PackageManagerAdapter } from "../adapters/types.ts";
import { byCodeUnit, hashText } from "../util/hash.ts";
import { PlanningError, type WorkspaceContext } from "./context.ts";
import type { PlanOperation, ProjectedArtifactEvidence } from "./manifest.ts";
import { parseJsonFile, stringifyJson, writeOperation } from "./scaffold-shared.ts";

type Write = Extract<PlanOperation, { kind: "write-file" }>;
type Importer = Extract<PlanOperation, { kind: "lockfile-importer" }>;

export class ProjectedWorkspace {
  private readonly operations: PlanOperation[];

  constructor(
    private readonly context: WorkspaceContext,
    private readonly packageManager: PackageManagerAdapter,
    operations: readonly PlanOperation[],
  ) {
    this.operations = [...operations];
  }

  transformJson(path: string, label: string, transform: (value: Record<string, unknown>) => Record<string, unknown>): void {
    const index = this.operations.findLastIndex((operation) => operation.kind === "write-file" && operation.path === path);
    const projected = index < 0 ? this.context.text(path) : (this.operations[index] as Write).contents;
    const contents = stringifyJson(transform(parseJsonFile(projected, path)));
    if (index < 0) this.operations.push(writeOperation(this.context, path, contents, label));
    else {
      const current = this.operations[index] as Write;
      this.operations[index] = { ...current, contents, resultHash: hashText(contents), generator: `${current.generator ?? "wiring"}+${label}` };
    }
  }

  transformImporter(packageRoot: string, transform: (block: string) => string): void {
    const index = this.operations.findIndex((operation) => operation.kind === "lockfile-importer" && operation.packageRoot === packageRoot);
    if (index < 0) throw new PlanningError(`cannot transform ${this.packageManager.lockfileName}: no planned importer mutation for ${packageRoot}`);
    const current = this.operations[index] as Importer;
    this.operations[index] = { ...current, block: transform(current.block) };
    this.rehashImporters();
  }

  finalize(): PlanOperation[] {
    assertCompiledOperationInvariants(this.context, this.packageManager, this.operations);
    return [...this.operations];
  }

  private rehashImporters(): void {
    let lockfile = this.context.text(this.packageManager.lockfileName);
    for (const [index, operation] of this.operations.entries()) {
      if (operation.kind !== "lockfile-importer") continue;
      const preconditionHash = hashText(lockfile);
      lockfile = this.packageManager.applyImporter(lockfile, operation.packageRoot, operation.block, operation.mode);
      this.operations[index] = { ...operation, preconditionHash, resultHash: hashText(lockfile) };
    }
  }
}

/** Refuse invalid compiler output before it can be serialized as a plausible plan. */
export function assertCompiledOperationInvariants(context: WorkspaceContext, adapter: PackageManagerAdapter, operations: readonly PlanOperation[]): void {
  const keys = new Set<string>();
  let lockfile = context.text(adapter.lockfileName);
  for (const operation of operations) {
    const key = operationKey(operation);
    if (keys.has(key)) throw new PlanningError(`compiler produced duplicate final mutation ${key}`);
    keys.add(key);
    if (operation.kind === "write-file") {
      if (operation.resultHash !== hashText(operation.contents)) throw new PlanningError(`compiler produced stale write result hash for ${operation.path}`);
    } else if (operation.kind === "lockfile-importer") {
      if (operation.preconditionHash !== hashText(lockfile)) throw new PlanningError(`compiler produced a stale lockfile precondition before importer ${operation.packageRoot}`);
      lockfile = adapter.applyImporter(lockfile, operation.packageRoot, operation.block, operation.mode);
      if (operation.resultHash !== hashText(lockfile)) throw new PlanningError(`compiler produced a stale lockfile result after importer ${operation.packageRoot}`);
    }
  }
}

/** Canonical final hashes for every structured artifact the compiler projects. */
export function projectedArtifactEvidence(operations: readonly PlanOperation[]): ProjectedArtifactEvidence[] {
  const artifacts = new Map<string, ProjectedArtifactEvidence>();
  for (const operation of operations) {
    if (operation.kind === "write-file") {
      const kind = operation.path.endsWith(".json") ? "json" : "structured";
      artifacts.set(operation.path, { path: operation.path, kind, resultHash: operation.resultHash });
    } else if (operation.kind === "lockfile-importer") {
      artifacts.set(operation.lockfile, { path: operation.lockfile, kind: "lockfile", resultHash: operation.resultHash });
    } else if (operation.kind === "migrate-path-keys") {
      artifacts.set(operation.path, { path: operation.path, kind: "structured", resultHash: operation.resultHash });
    }
  }
  return [...artifacts.values()].sort((left, right) => byCodeUnit(left.path, right.path));
}

function operationKey(operation: PlanOperation): string {
  switch (operation.kind) {
    case "move": case "move-with-rewrite": return `move:${operation.source}`;
    case "rewrite-import": return `path:${operation.file}`;
    case "rewrite-fs-reference": return `fsref:${operation.file}`;
    case "write-file": case "migrate-path-keys": return `path:${operation.path}`;
    case "lockfile-importer": return `importer:${operation.packageRoot}`;
  }
}
