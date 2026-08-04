/** Public seams for rendering target-package and consumer wiring operations. */

import { relative, resolve } from "node:path";

import type { ApplicationConfig, MonocarveConfig, ScaffoldTemplatesConfig } from "../config.ts";
import type { PackageManagerAdapter, TaskRunnerAdapter } from "../adapters/types.ts";
import type { PublicModule } from "./manifest.ts";
import type { WorkspaceContext } from "./context.ts";
import type { InferredDependencies } from "./dependencies.ts";

export interface ScaffoldInput {
  readonly context: WorkspaceContext;
  readonly config: MonocarveConfig;
  readonly application: ApplicationConfig;
  readonly packageManager: PackageManagerAdapter;
  readonly taskRunner: TaskRunnerAdapter;
  readonly packageName: string;
  readonly packageRoot: string;
  readonly projectId: string;
  readonly templates?: ScaffoldTemplatesConfig;
  readonly production: readonly string[];
  /** Tests that travel with the new package. An explicit empty set matters. */
  readonly tests?: readonly string[];
  /** Configured non-code assets which move into this package. */
  readonly assets?: readonly string[];
  readonly dependencies: InferredDependencies;
  readonly publicModules?: readonly PublicModule[];
  readonly workspaceDependencyRoots?: Readonly<Record<string, string>>;
}

/** Barrel specifier for a moved file, per the configured resolution style. */
export function barrelSpecifier(templates: ScaffoldTemplatesConfig, targetRelative: string): string {
  const posix = targetRelative.replaceAll("\\", "/");
  switch (templates.barrelSpecifier) {
    case "extensionless": return posix.replace(/\.[cm]?[jt]sx?$/, "");
    case "js": return posix.replace(/\.[cm]?tsx?$/, ".js");
    case "extension": return posix;
  }
}

/** `relative()` kept POSIX for template rendering. */
export function relativeToRoot(packageRoot: string): string {
  return relative(resolve("/", packageRoot), "/").replaceAll("\\", "/") || ".";
}

export { packageOperations } from "./scaffold-package.ts";
export { consumerWiringOperations, projectedLockfile, type ConsumerWiringInput } from "./scaffold-consumers.ts";
