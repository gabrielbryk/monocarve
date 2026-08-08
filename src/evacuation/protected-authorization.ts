import { isAbsolute } from "node:path";

import { getApplication, type MonocarveConfig } from "../config.ts";
import type { DependencyGraph } from "../graph/model.ts";
import { byCodeUnit } from "../util/hash.ts";
import { normalizePath } from "../util/paths.ts";
import { EvacuationSelectorError } from "./selectors.ts";

/** Canonicalize and prove evacuation-only authorization of configured protected roots. */
export function authorizeProtectedRoots(
  config: MonocarveConfig,
  graph: DependencyGraph,
  applicationName: string,
  requested: readonly string[],
  authorizations: readonly string[],
): string[] {
  const roots = [...new Set(authorizations.map(normalizeAuthorization))].sort(byCodeUnit);
  const application = getApplication(config, applicationName);
  for (const root of roots) {
    if (!config.portfolio.protectedPaths.includes(root)) {
      throw new EvacuationSelectorError(
        `protected-path authorization must exactly name a configured portfolio.protectedPaths root: ${root}`,
      );
    }
    if (root !== application.sourceRoot && !root.startsWith(`${application.sourceRoot}/`)) {
      throw new EvacuationSelectorError(
        `protected-path authorization crosses application ${JSON.stringify(applicationName)}: ${root}`,
      );
    }
    const protectedProduction = graph.paths.filter((path) => path === root || path.startsWith(`${root}/`));
    if (protectedProduction.length === 0 || protectedProduction.some((path) => !requested.includes(path))) {
      throw new EvacuationSelectorError(
        `protected-path authorization is broader than or outside the selected evacuation: ${root}`,
      );
    }
  }
  return roots;
}

export function isAuthorizedProtectedPath(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

function normalizeAuthorization(value: string): string {
  if (isAbsolute(value)) throw new EvacuationSelectorError(`protected-path authorization must be workspace-relative: ${value}`);
  const normalized = normalizePath(value).replace(/\/+$/, "");
  if (!normalized || normalized.split("/").some((part) => part === ".." || part === "")) {
    throw new EvacuationSelectorError(`protected-path authorization must be workspace-relative: ${value}`);
  }
  return normalized;
}
