/** Small deterministic rendering primitives shared by scaffold stages. */

import { resolve } from "node:path";

import type { PackageManagerAdapter, TaskRunnerAdapter } from "../adapters/types.ts";
import { scaffoldFor, type ApplicationConfig, type MonocarveConfig, type ScaffoldTemplatesConfig, type TemplateSource } from "../config.ts";
import { hashText } from "../util/hash.ts";
import { parseJson } from "../util/json.ts";
import { relativePosix } from "../util/paths.ts";
import { renderTemplate, type TemplateVars } from "../util/template.ts";
import { PlanningError, type WorkspaceContext } from "./context.ts";
import type { InferredDependencies } from "./dependencies.ts";
import { formatGeneratedText } from "./format-generated.ts";
import type { PlanOperation, PublicModule } from "./manifest.ts";

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
  /** Destination directory inside the package; see `target-layout.ts`. */
  readonly targetSubpath?: string;
  readonly workspaceDependencyRoots?: Readonly<Record<string, string>>;
}

/** Barrel specifier for a moved file, per the configured resolution style. */
export function barrelSpecifier(templates: ScaffoldTemplatesConfig, targetRelative: string): string {
  const posix = targetRelative.replaceAll("\\", "/");
  if (templates.barrelSpecifier === "extensionless") return posix.replace(/\.[cm]?[jt]sx?$/, "");
  if (templates.barrelSpecifier === "js") return posix.replace(/\.[cm]?tsx?$/, ".js");
  return posix;
}

export function writeOperation(context: WorkspaceContext, path: string, contents: string, generator: string): PlanOperation {
  const formatted = formatGeneratedText(context.rootDir, path, contents);
  return { kind: "write-file", path, contents: formatted, preconditionHash: context.state(path), resultHash: hashText(formatted), generator };
}

export function templatesFor(input: ScaffoldInput): ScaffoldTemplatesConfig {
  return input.templates ?? scaffoldFor(input.config, input.application);
}

export function templateVars(input: ScaffoldInput, templates = templatesFor(input)): TemplateVars {
  return {
    package: input.packageName,
    packageRoot: input.packageRoot,
    project: input.projectId,
    app: input.application.name,
    scope: input.config.packageScope,
    entrypoint: templates.entrypoint,
    relativeRoot: relativePosix(resolve("/", input.packageRoot), "/") || ".",
  };
}

export function render(input: ScaffoldInput, source: TemplateSource, vars = templateVars(input)): string {
  const text = "contents" in source ? source.contents : input.context.text(source.file);
  return renderTemplate(text, vars);
}

export function parseJsonFile(text: string, path: string): Record<string, unknown> {
  return parseJson(text, (reason) => new PlanningError(`scaffold template for ${path} must be JSON: ${reason}`)) as Record<string, unknown>;
}

export function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function insertSorted<T>(entries: readonly [string, T][], name: string, value: T): [string, T][] {
  const index = entries.findIndex(([key]) => name < key);
  return index < 0 ? [...entries, [name, value]] : [...entries.slice(0, index), [name, value], ...entries.slice(index)];
}
