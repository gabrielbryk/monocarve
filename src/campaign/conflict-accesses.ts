import type { PlanOperation } from "../plan/manifest.ts";
import { byCodeUnit } from "../util/hash.ts";
import { normalizePath } from "../util/paths.ts";
import type { CampaignPlan, OperationPathAccess, PathAccessMode, PathAccessRole } from "./conflict-types.ts";

export function accessesFor(plan: CampaignPlan): OperationPathAccess[] {
  const accesses = plan.manifest.operations.flatMap((operation, index) => operationAccesses(plan, operation, index));
  for (const generated of plan.manifest.generatedFiles) {
    if (generated.regenerateOnApply !== true) continue;
    accesses.push(
      access(plan, generated.path, "exact", "read-write", "generated-artifact", null, "regenerate-artifact", [generated.regenerate]),
      // A generator may read one file or a whole directory. The manifest has
      // no shape discriminator, so tree scope is the only conservative claim.
      access(plan, generated.source, "tree", "read", "generated-source", null, "regenerate-artifact", [generated.regenerate]),
    );
  }
  return accesses.sort(compareAccesses);
}

export function compareAccesses(left: OperationPathAccess, right: OperationPathAccess): number {
  return byCodeUnit(left.path, right.path) || byCodeUnit(left.role, right.role) ||
    (left.operationIndex ?? Number.MAX_SAFE_INTEGER) - (right.operationIndex ?? Number.MAX_SAFE_INTEGER) ||
    byCodeUnit(left.operationKind, right.operationKind);
}

function operationAccesses(plan: CampaignPlan, operation: PlanOperation, index: number): OperationPathAccess[] {
  switch (operation.kind) {
    case "move":
    case "move-with-rewrite":
      return [
        access(plan, operation.source, "exact", "read-write", "move-source", index, operation.kind, []),
        access(plan, operation.target, "exact", "write", "move-target", index, operation.kind, []),
      ];
    case "rewrite-import":
      return [access(plan, operation.file, "exact", "read-write", "consumer-source", index, operation.kind, operation.donors)];
    case "rewrite-fs-reference":
      return [access(plan, operation.file, "exact", "read-write", "consumer-source", index, operation.kind, operation.rewrites.map((rewrite) => rewrite.donor))];
    case "rewrite-path-reference":
      return [access(plan, operation.file, "exact", "read-write", "consumer-source", index, operation.kind, operation.rewrites.map((rewrite) => rewrite.donor))];
    case "write-file":
      return [access(
        plan,
        operation.path,
        "exact",
        operation.preconditionHash === "missing" ? "write" : "read-write",
        writeRole(operation.generator),
        index,
        operation.kind,
        writeKeys(plan, operation.generator),
      )];
    case "delete-file":
      return [access(plan, operation.path, "exact", "read-write", "operation-output", index, operation.kind, [])];
    case "lockfile-importer":
      return [access(
        plan,
        operation.lockfile,
        "exact",
        "read-write",
        "lockfile-importer",
        index,
        operation.kind,
        [operation.mode === "replace" ? `dependency:${plan.manifest.target.packageName}` : `importer:${operation.packageRoot}`],
      )];
    case "migrate-path-keys":
      return [access(plan, operation.path, "exact", "read-write", "path-key-artifact", index, operation.kind, [operation.command])];
  }
}

function writeRole(generator: string | undefined): PathAccessRole {
  switch (generator) {
    case "scaffold:package-json": return "package-manifest";
    case "wiring:consumer-dependency": return "consumer-manifest";
    case "wiring:consumer-project-references": return "consumer-project-references";
    case "scaffold:workspace-membership": return "workspace-registry";
    case "scaffold:project-registration": return "task-registry";
    case "scaffold:entrypoint": return "entrypoint";
    case "scaffold:task-file": return "task-file";
    default: return generator?.startsWith("scaffold:") === true ? "scaffold-output" : "operation-output";
  }
}

function writeKeys(plan: CampaignPlan, generator: string | undefined): string[] {
  switch (generator) {
    case "scaffold:workspace-membership":
    case "wiring:consumer-project-references": return [plan.manifest.target.packageRoot];
    case "scaffold:project-registration": return [plan.manifest.target.projectId ?? plan.manifest.target.packageRoot];
    case "wiring:consumer-dependency": return [plan.manifest.target.packageName];
    default: return [];
  }
}

function access(
  plan: CampaignPlan,
  path: string,
  scope: OperationPathAccess["scope"],
  mode: PathAccessMode,
  role: PathAccessRole,
  operationIndex: number | null,
  operationKind: OperationPathAccess["operationKind"],
  keys: readonly string[],
): OperationPathAccess {
  return {
    candidateId: plan.candidateId,
    planId: plan.manifest.planId,
    path: normalizePath(path).replace(/\/$/, ""),
    scope,
    mode,
    role,
    operationIndex,
    operationKind,
    keys: [...new Set(keys)].sort(byCodeUnit),
  };
}
