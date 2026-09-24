import type { PackageManagerAdapter, TaskRunnerAdapter } from "../adapters/types.ts";
import { compilerBuildIdentity } from "../build-identity.ts";
import type { MonocarveConfig, ResolvedExtractionProfile, ScaffoldTemplatesConfig } from "../config.ts";
import { configDigest } from "../config.ts";
import { hashJson, type Sha256 } from "../util/hash.ts";
import type { PlanProvenance } from "./manifest.ts";

export interface PlanProvenanceInput {
  readonly config: MonocarveConfig;
  readonly profileGates: ResolvedExtractionProfile["gates"];
  readonly scaffoldTemplates: ScaffoldTemplatesConfig;
  readonly packageManager: PackageManagerAdapter;
  readonly taskRunner: TaskRunnerAdapter;
  readonly rootPackageJson?: string;
}

export function buildPlanProvenance(input: PlanProvenanceInput): PlanProvenance {
  return {
    configDigest: configDigest(input.config),
    policyDigest: policyDigest(input),
    compiler: compilerBuildIdentity(),
    adapters: {
      packageManager: adapterProvenance(input.packageManager, input.rootPackageJson),
      taskRunner: adapterProvenance(input.taskRunner, input.rootPackageJson),
    },
  };
}

export function policyDigest(input: Pick<PlanProvenanceInput, "config" | "profileGates" | "scaffoldTemplates">): Sha256 {
  return hashJson({
    commitTemplates: input.config.commitTemplates,
    gates: input.config.gates,
    profileGates: input.profileGates,
    scaffoldTemplates: input.scaffoldTemplates,
  });
}

function adapterProvenance(
  adapter: PackageManagerAdapter | TaskRunnerAdapter,
  rootPackageJson: string | undefined,
): PlanProvenance["adapters"]["packageManager"] {
  const declaredVersion = rootPackageJson === undefined ? undefined : adapter.declaredVersion?.(rootPackageJson);
  return { id: adapter.id, contractVersion: adapter.contractVersion ?? 1, ...(declaredVersion === undefined ? {} : { declaredVersion }) };
}
