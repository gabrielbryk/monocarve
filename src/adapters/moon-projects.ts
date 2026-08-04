/** Moon project discovery and deterministic registry edits. */

import type { AdapterEditResult } from "./types.ts";

export function registerMoonProject(workspaceConfigText: string, packageRoot: string, projectId: string): AdapterEditResult {
  const lines = workspaceConfigText.split("\n");
  const registry = projectRegistry(lines);
  if (!registry) return { kind: "unmet-precondition", reason: "workspace configuration has no projects registry" };
  const projectLines = lines.slice(registry.start, registry.end);
  const globResult = globRegistration(projectLines, packageRoot);
  if (globResult) return globResult;
  const existing = explicitRegistration(projectLines, projectId);
  if (existing) return existing.root === packageRoot ? { kind: "already-satisfied" } : duplicateId(projectId, existing.root);
  lines.splice(insertionPoint(lines, registry, projectId), 0, `  ${projectId}: '${packageRoot}'`);
  return { kind: "changed", contents: lines.join("\n") };
}

interface RegistryRange {
  readonly start: number;
  readonly end: number;
}

function projectRegistry(lines: readonly string[]): RegistryRange | undefined {
  const projects = lines.findIndex((line) => /^projects:\s*$/.test(line));
  if (projects < 0) return undefined;
  const nextTopLevel = lines.findIndex((line, index) => index > projects && /^\S/.test(line) && !line.startsWith("#"));
  return { start: projects + 1, end: nextTopLevel < 0 ? lines.length : nextTopLevel };
}

function globRegistration(lines: readonly string[], packageRoot: string): AdapterEditResult | undefined {
  if (!lines.some((line) => /^\s+globs:/.test(line))) return undefined;
  return workspaceGlobs(lines).some((glob) => coversProject(glob, packageRoot))
    ? { kind: "already-satisfied" }
    : { kind: "unmet-precondition", reason: `project discovery globs do not cover ${packageRoot}` };
}

function workspaceGlobs(lines: readonly string[]): string[] {
  return lines.flatMap((line) => {
    const glob = line.match(/^\s*-\s*['"]?([^'"\s]+)['"]?\s*$/)?.[1];
    return glob === undefined ? [] : [glob];
  });
}

function coversProject(glob: string, packageRoot: string): boolean {
  const directoryGlob = glob.endsWith("/moon.yml") ? glob.slice(0, -"/moon.yml".length) : glob;
  if (directoryGlob === packageRoot) return true;
  if (!directoryGlob.endsWith("/*")) return false;
  const base = directoryGlob.slice(0, -2);
  return packageRoot.startsWith(`${base}/`) && !packageRoot.slice(base.length + 1).includes("/");
}

function explicitRegistration(lines: readonly string[], projectId: string): { root: string } | undefined {
  const pattern = new RegExp(`^\\s{2}(?:'${projectId}'|"${projectId}"|${projectId}):\\s*['"]?([^'"\\s]+)['"]?\\s*$`);
  const match = lines.map((line) => line.match(pattern)).find((candidate) => candidate !== null);
  return match?.[1] === undefined ? undefined : { root: match[1] };
}

function duplicateId(projectId: string, root: string): AdapterEditResult {
  return { kind: "unmet-precondition", reason: `project id ${projectId} is already registered for ${root}` };
}

function insertionPoint(lines: readonly string[], registry: RegistryRange, projectId: string): number {
  for (let index = registry.start; index < registry.end; index += 1) {
    const name = registryKey(lines[index] ?? "");
    if (name !== undefined && projectId < name) return index;
  }
  return registry.end;
}

function registryKey(line: string): string | undefined {
  const key = line.match(/^ {2}(?:'([^']+)'|"([^"]+)"|([^:\s]+)):/);
  return key?.[1] ?? key?.[2] ?? key?.[3];
}
