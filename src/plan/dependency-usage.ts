/** Repository-wide retained-use evidence for dependency decisions. */

import { resolve } from "node:path";
import ts from "typescript";
import { applicationOwner } from "../config.ts";
import { byCodeUnit } from "../util/hash.ts";
import { typesPackageName, type WorkspaceContext } from "./context.ts";

export interface DependencyUsageEvidence {
  readonly name: string;
  readonly retainedSources: readonly string[];
  readonly tsconfigTypes: readonly { readonly tsconfig: string; readonly type: string }[];
  readonly explicitlyKept: boolean;
}

export function collectDependencyUsage(input: {
  readonly context: WorkspaceContext;
  readonly donorRoot: string;
  readonly movedSources: readonly string[];
  readonly dependencyNames: readonly string[];
}): DependencyUsageEvidence[] {
  const moved = new Set(input.movedSources);
  const names = [...new Set(input.dependencyNames)].sort(byCodeUnit);
  const retained = new Map(names.map((name) => [name, [] as string[]]));
  for (const path of input.context.repositorySources()) {
    if (moved.has(path) || input.context.ownerOf(path) !== input.donorRoot) continue;
    const used = new Set(
      input.context.moduleReferences(path).flatMap((reference) => {
        if (reference.specifier === null || reference.specifier.startsWith(".")) return [];
        const name = input.context.packageNameOf(reference.specifier);
        return name === undefined ? [] : [name];
      }),
    );
    for (const name of used) retained.get(name)?.push(path);
  }
  const configTypes = configuredTypes(input.context, input.donorRoot);
  return names.map((name) => ({
    name,
    retainedSources: retained.get(name)!.sort(byCodeUnit),
    tsconfigTypes: configTypes.filter((entry) => entry.packages.includes(name)).map(({ tsconfig, type }) => ({ tsconfig, type })),
    explicitlyKept: input.context.config.dependencyPruning.keep.includes(name),
  }));
}

function configuredTypes(context: WorkspaceContext, donorRoot: string): { tsconfig: string; type: string; packages: readonly string[] }[] {
  return context.config.applications
    .filter((application) => applicationOwner(application) === donorRoot)
    .flatMap((application) => {
      const parsed = ts.getParsedCommandLineOfConfigFile(
        resolve(context.rootDir, application.tsconfig),
        {},
        { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
      );
      return (parsed?.options.types ?? []).map((type) => ({
        tsconfig: application.tsconfig,
        type,
        packages: [...new Set([inputPackageName(context, type), typesPackageName(type)].filter((name): name is string => name !== undefined))],
      }));
    })
    .sort((left, right) => byCodeUnit(left.tsconfig, right.tsconfig) || byCodeUnit(left.type, right.type));
}

function inputPackageName(context: WorkspaceContext, type: string): string | undefined {
  return context.packageNameOf(type);
}
