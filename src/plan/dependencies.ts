/**
 * Dependency inference for a generated package.
 *
 * The rules are all consequences of one requirement — the new package must
 * install and typecheck on its own, without inheriting anything from the
 * application it left:
 *
 *  - a specifier imported only by a moved *test* is a devDependency;
 *  - a specifier imported only as a *type* is a devDependency, because it is
 *    erased at runtime;
 *  - a version is never invented: it is whatever the donating owners (or the
 *    workspace root) already declare, and a disagreement between them is an
 *    error rather than a coin flip;
 *  - a workspace package becomes `workspace:*` plus a project reference, so the
 *    generated tsconfig can build against it.
 */

import type { DependencyGraph } from "../graph/model.ts";
import type { WorkspaceContext } from "./context.ts";
import { collectDependencyEvidence } from "./dependency-evidence.ts";
import { resolveDependencies } from "./dependency-resolution.ts";

export interface InferredDependencies {
  runtime: Record<string, string>;
  dev: Record<string, string>;
  /** Workspace directories the new package must reference from its tsconfig. */
  packageReferences: string[];
}

export function inferDependencies(
  context: WorkspaceContext,
  graph: DependencyGraph,
  sources: readonly string[],
  packageName: string,
): InferredDependencies {
  return resolveDependencies(context, graph, collectDependencyEvidence(context, graph, sources, packageName));
}
