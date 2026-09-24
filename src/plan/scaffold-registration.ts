/** Scaffold operations beyond the package's manifest, entrypoint, and tsconfig: extra files, workspace registration, and the lockfile importer. */

import type { AdapterEditResult } from "../adapters/types.ts";
import { hashText } from "../util/hash.ts";
import { PlanningError } from "./context.ts";
import type { PlanOperation } from "./manifest.ts";
import { render, writeOperation, type ScaffoldInput, type templatesFor } from "./scaffold-shared.ts";

export function extraFileOperations(input: ScaffoldInput, templates: ReturnType<typeof templatesFor>): PlanOperation[] {
  return Object.entries(templates.extraFiles).flatMap(([name, source]) => {
    if (name === templates.projectReferences.target) return [];
    const path = `${input.packageRoot}/${name}`;
    return input.context.exists(path) ? [] : [writeOperation(input.context, path, render(input, source), `scaffold:extra:${name}`)];
  });
}

export function registrationOperations(input: ScaffoldInput): (PlanOperation | undefined)[] {
  return [workspaceMembershipOperation(input), projectRegistrationOperation(input)];
}

function workspaceMembershipOperation(input: ScaffoldInput): PlanOperation | undefined {
  const path = input.packageManager.workspaceManifestName;
  if (!path) return undefined;
  if (!input.context.exists(path)) throw new PlanningError(`${path} is required to register ${input.packageRoot} as a workspace package`);
  return requiredEditOperation(
    input,
    path,
    input.packageManager.workspaceManifestEdit(input.context.text(path), input.packageRoot),
    "scaffold:workspace-membership",
  );
}

function projectRegistrationOperation(input: ScaffoldInput): PlanOperation | undefined {
  const path = input.taskRunner.projectRegistryFileName;
  if (!path) return undefined;
  if (!input.context.exists(path)) throw new PlanningError(`${path} is required to register project ${input.projectId}`);
  return requiredEditOperation(
    input,
    path,
    input.taskRunner.registerProject(input.context.text(path), input.packageRoot, input.projectId),
    "scaffold:project-registration",
  );
}

function requiredEditOperation(input: ScaffoldInput, path: string, outcome: AdapterEditResult, generator: string): PlanOperation | undefined {
  if (outcome.kind === "already-satisfied") return undefined;
  if (outcome.kind === "unmet-precondition") throw new PlanningError(`${generator} cannot update ${path}: ${outcome.reason}`);
  if (outcome.contents === input.context.text(path)) throw new PlanningError(`${generator} reported a change to ${path} without changing its contents`);
  return writeOperation(input.context, path, outcome.contents, generator);
}

export interface ProjectedImporter {
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies: Readonly<Record<string, string>>;
  readonly packageName?: string;
  readonly packageVersion?: string;
}

export function lockfileImporterOperation(input: ScaffoldInput, projected: ProjectedImporter, scaffolding: boolean): PlanOperation | undefined {
  if (!scaffolding && Object.keys(input.dependencies.runtime).length === 0 && Object.keys(input.dependencies.dev).length === 0) return undefined;
  const lockfile = input.packageManager.lockfileName;
  if (!input.context.exists(lockfile)) throw new PlanningError(`${lockfile} is required to add an importer for ${input.packageRoot}`);
  const current = input.context.text(lockfile);
  const existing = input.packageManager.importerBlock(current, input.packageRoot);
  const renderInput = {
    packageRoot: input.packageRoot,
    ...projected,
    lockfileText: current,
    workspaceRoots: workspaceRootsFor(input),
    ...(input.dependencies.resolutionRoots === undefined ? {} : { resolutionRoots: input.dependencies.resolutionRoots }),
  };
  if (!scaffolding) {
    if (existing === undefined)
      throw new PlanningError(`${lockfile} has no importer entry for existing package ${input.packageRoot}; the lockfile is out of date with the workspace`);
    const block = input.packageManager.addBlockDependencies(existing, renderInput);
    if (block === existing) return undefined;
    return {
      kind: "lockfile-importer",
      lockfile,
      packageRoot: input.packageRoot,
      block,
      mode: "replace",
      preconditionHash: hashText(current),
      resultHash: hashText(input.packageManager.replaceImporter(current, input.packageRoot, block)),
    };
  }
  if (existing !== undefined)
    throw new PlanningError(`${lockfile} already has an importer for ${input.packageRoot}, but ${input.packageRoot}/package.json is absent`);
  const block = `${input.packageManager.renderImporterBlock(renderInput)}\n\n`;
  return {
    kind: "lockfile-importer",
    lockfile,
    packageRoot: input.packageRoot,
    block,
    mode: "insert",
    preconditionHash: hashText(current),
    resultHash: hashText(input.packageManager.insertImporter(current, input.packageRoot, block)),
  };
}

export function workspaceRootsFor(input: ScaffoldInput): Record<string, string> {
  const roots = Object.fromEntries(
    input.dependencies.packageReferences.flatMap((owner) => {
      const name = input.context.manifest(owner).name;
      return name ? [[name, owner]] : [];
    }),
  );
  return { ...input.context.workspacePackageRoots(), ...roots, ...input.workspaceDependencyRoots };
}
