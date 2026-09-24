/** Structural validation of the JSON campaign and multi-preparation specs the CLI reads. */
import { UsageError } from "../errors.ts";
import { isJsonObject } from "../util/json.ts";

export interface StableCampaignSpec {
  readonly application: string;
  readonly targets: readonly { readonly path: string; readonly packageName: string; readonly packageRoot?: string }[];
}

export function validateStableCampaignSpec(value: Record<string, unknown>): StableCampaignSpec {
  const application = value.application;
  const rawTargets = value.targets;
  if (typeof application !== "string" || !Array.isArray(rawTargets) || rawTargets.length === 0) {
    throw new UsageError("campaign target list requires application and a non-empty targets array");
  }
  const identities = new Set<string>();
  const targets: StableCampaignSpec["targets"][number][] = [];
  for (const [index, entry] of rawTargets.entries()) {
    const target: Record<string, unknown> = isJsonObject(entry) ? entry : {};
    const path = target.path;
    const packageName = target.packageName;
    const packageRoot = target.packageRoot;
    if (
      typeof path !== "string" ||
      typeof packageName !== "string" ||
      !path ||
      !packageName ||
      (packageRoot !== undefined && typeof packageRoot !== "string")
    ) {
      throw new UsageError(`campaign target ${index} requires non-empty path and packageName`);
    }
    if (identities.has(path)) throw new UsageError(`duplicate campaign target path: ${path}`);
    identities.add(path);
    targets.push({ path, packageName, ...(packageRoot === undefined ? {} : { packageRoot }) });
  }
  return { application, targets };
}

/** Compile a read-only, declaration-SCC seam proposal for one configured source file. */

export interface MultiPreparationSpec {
  readonly candidate: string;
  readonly members: readonly { file: string; candidate: string; target: string; moduleSpecifier: string; groups: readonly string[] }[];
}

export function validateMultiPreparationSpec(value: Record<string, unknown>): MultiPreparationSpec {
  const candidate = value.candidate;
  const rawMembers = value.members;
  if (typeof candidate !== "string" || !Array.isArray(rawMembers) || rawMembers.length < 2)
    throw new UsageError("multi-file preparation spec requires candidate and at least two members");
  const members = rawMembers.map((entry, index) => {
    const member: Record<string, unknown> = isJsonObject(entry) ? entry : {};
    const { file, candidate: memberCandidate, target, moduleSpecifier, groups } = member;
    if (
      typeof file !== "string" ||
      typeof memberCandidate !== "string" ||
      typeof target !== "string" ||
      typeof moduleSpecifier !== "string" ||
      !Array.isArray(groups) ||
      !groups.every((group): group is string => typeof group === "string")
    ) {
      throw new UsageError(`multi-file preparation spec member ${index} requires file, candidate, target, moduleSpecifier, and groups`);
    }
    return { file, candidate: memberCandidate, target, moduleSpecifier, groups };
  });
  return { candidate, members };
}
