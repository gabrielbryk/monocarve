/** moon and no-runner task adapter facades. */

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { MonocarveError } from "../errors.ts";
import { registerMoonProject } from "./moon-projects.ts";
import type { AdapterEditResult, TaskRunnerAdapter } from "./types.ts";

export class TaskRunnerError extends MonocarveError {
  override readonly name = "TaskRunnerError";
}

export const moonAdapter: TaskRunnerAdapter = {
  id: "moon",
  contractVersion: 1,
  declaredVersion: (text) => declaredDependencyVersion(text, "@moonrepo/cli"),
  projectFileName: "moon.yml",
  projectRegistryFileName: ".moon/workspace.yml",
  projectIdFor: (_packageName, packageRoot) => moonProjectId(packageRoot),
  projectIdOf: (rootDir, packageRoot) => declaredMoonId(rootDir, packageRoot) ?? basename(packageRoot),
  registerProject: registerMoonProject,
  wrapGateCommand: shellCommand,
};

/** Task runner for workspaces that execute package scripts directly. */
export const noneTaskRunner: TaskRunnerAdapter = {
  id: "none",
  contractVersion: 1,
  declaredVersion: () => undefined,
  projectFileName: null,
  projectRegistryFileName: null,
  projectIdFor: (packageName) => packageName,
  projectIdOf: (_rootDir, packageRoot) => basename(packageRoot),
  registerProject: (): AdapterEditResult => ({ kind: "already-satisfied" }),
  wrapGateCommand: shellCommand,
};

function declaredDependencyVersion(text: string, name: string): string | undefined {
  try {
    const manifest = JSON.parse(text) as Record<string, unknown>;
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
      const entries = manifest[section];
      if (entries !== null && typeof entries === "object" && !Array.isArray(entries)) {
        const value = (entries as Record<string, unknown>)[name];
        if (typeof value === "string" && value !== "") return value;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function declaredMoonId(rootDir: string, packageRoot: string): string | undefined {
  const file = join(rootDir, packageRoot, "moon.yml");
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, "utf8").split("\n").find((candidate) => candidate.startsWith("id:"));
  return line ? line.slice("id:".length).trim().replace(/^['"]|['"]$/g, "") : undefined;
}

function moonProjectId(packageRoot: string): string {
  const name = basename(packageRoot);
  if (!name) throw new TaskRunnerError(`cannot derive a moon project id from ${JSON.stringify(packageRoot)}`);
  return name;
}

function shellCommand(command: string): readonly string[] {
  return ["sh", "-c", command];
}
