/** Small deterministic rendering primitives shared by scaffold stages. */

import { resolve } from "node:path";

import { scaffoldFor, type ScaffoldTemplatesConfig, type TemplateSource } from "../config.ts";
import { hashText } from "../util/hash.ts";
import { relativePosix } from "../util/paths.ts";
import { renderTemplate, type TemplateVars } from "../util/template.ts";
import type { PlanOperation } from "./manifest.ts";
import { PlanningError, type WorkspaceContext } from "./context.ts";
import type { ScaffoldInput } from "./scaffold.ts";

export function writeOperation(context: WorkspaceContext, path: string, contents: string, generator: string): PlanOperation {
  return { kind: "write-file", path, contents, preconditionHash: context.state(path), resultHash: hashText(contents), generator };
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
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new PlanningError(`scaffold template for ${path} must be JSON: ${(error as Error).message}`);
  }
}

export function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function insertSorted<T>(entries: readonly [string, T][], name: string, value: T): [string, T][] {
  const index = entries.findIndex(([key]) => name < key);
  return index < 0 ? [...entries, [name, value]] : [...entries.slice(0, index), [name, value], ...entries.slice(index)];
}
