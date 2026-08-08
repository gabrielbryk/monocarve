import { isAbsolute } from "node:path";

import { getApplication, type MonocarveConfig } from "../config.ts";
import { isCompositionRoot } from "../graph/layers.ts";
import type { DependencyGraph } from "../graph/model.ts";
import { byCodeUnit } from "../util/hash.ts";
import { normalizePath } from "../util/paths.ts";
import { EvacuationSelectorError } from "./selectors.ts";

/** Canonicalize and prove evacuation-only inclusion of selected composition roots. */
export function includeCompositionRoots(
  config: MonocarveConfig,
  graph: DependencyGraph,
  applicationName: string,
  requested: readonly string[],
  inclusions: readonly string[],
): string[] {
  const roots = [...new Set(inclusions.map(normalizeInclusion))].sort(byCodeUnit);
  const application = getApplication(config, applicationName);
  for (const root of roots) {
    if (root !== application.sourceRoot && !root.startsWith(`${application.sourceRoot}/`)) {
      throw new EvacuationSelectorError(`composition-root inclusion crosses application ${JSON.stringify(applicationName)}: ${root}`);
    }
    const node = graph.nodes.get(root);
    if (node?.zone !== "application" || node.application !== applicationName || !isCompositionRoot(config, root)) {
      throw new EvacuationSelectorError(`composition-root inclusion must exactly name a configured composition root in application ${JSON.stringify(applicationName)}: ${root}`);
    }
    if (!requested.includes(root)) {
      throw new EvacuationSelectorError(`composition-root inclusion is outside the selected evacuation: ${root}`);
    }
  }
  return roots;
}

function normalizeInclusion(value: string): string {
  if (isAbsolute(value)) throw new EvacuationSelectorError(`composition-root inclusion must be workspace-relative: ${value}`);
  const normalized = normalizePath(value).replace(/\/+$/, "");
  if (!normalized || normalized.split("/").some((part) => part === ".." || part === "")) {
    throw new EvacuationSelectorError(`composition-root inclusion must be workspace-relative: ${value}`);
  }
  return normalized;
}
