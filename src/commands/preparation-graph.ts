import type { GraphMetricSnapshot } from "../campaign/index.ts";
import { summarizeGraph } from "../graph/index.ts";
import { hashJson } from "../util/hash.ts";
import type { LoadedGraph } from "./shared.ts";

/** Capture the stable graph metrics recorded in campaign ledgers. */
export function graphSnapshot(loaded: LoadedGraph): GraphMetricSnapshot {
  const summary = summarizeGraph(loaded.graph);
  const metrics = {
    moduleCount: summary.moduleCount,
    edgeCount: summary.edgeCount,
    unresolvedCount: summary.unresolvedCount,
    dynamicImportCount: summary.dynamicImportCount,
    applicationModuleCount: summary.byZone.application,
    packageModuleCount: summary.byZone.package,
    repositoryModuleCount: summary.byZone.repo,
    externalModuleCount: summary.byZone.external,
  };
  return { digest: hashJson(metrics), metrics };
}
