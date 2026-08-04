/** Render and verify the repository-owned policy for source preparation. */

import { ConfigError } from "../errors.ts";
import { byCodeUnit } from "../util/hash.ts";
import { renderTemplate, templatePlaceholders } from "../util/template.ts";
import { applicationFor, applicationOwner } from "./helpers.ts";
import type { MonocarveConfig } from "./schema.ts";

const PREPARATION_PLACEHOLDERS = ["app", "moduleSpecifier", "owner", "sourcePath", "targetPath"] as const;

export interface PreparationPolicyRenderInput {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly targetModuleSpecifier: string;
}

export interface RenderedPreparationPolicy {
  readonly commit: { readonly subject: string; readonly body?: string };
  readonly gates: {
    readonly package: readonly string[];
    readonly project: readonly string[];
    readonly workspace: readonly string[];
  };
}

/**
 * Render the exact repository policy a preparation manifest records. This
 * refuses an omitted policy, subject, or aggregate gate set: those omissions
 * are valid for legacy whole-file extraction configs, never a preparation
 * proof.
 */
export function renderPreparationPolicy(
  config: MonocarveConfig,
  input: PreparationPolicyRenderInput,
): RenderedPreparationPolicy {
  const app = applicationFor(config, input.sourcePath);
  if (!app) throw new ConfigError(`preparation donor ${JSON.stringify(input.sourcePath)} is not in a configured application`);
  const policy = config.preparation;
  if (!policy.commit) throw new ConfigError("preparation policy must configure commit.subject; refusing to invent a commit subject");
  if (!policy.gates) throw new ConfigError("preparation policy must configure repository gates; refusing to certify zero gates");
  const vars = {
    app: app.name,
    moduleSpecifier: input.targetModuleSpecifier,
    owner: applicationOwner(app),
    sourcePath: input.sourcePath,
    targetPath: input.targetPath,
  };
  validateTemplates(policy.commit.subject, "preparation.commit.subject");
  if (policy.commit.body !== undefined) validateTemplates(policy.commit.body, "preparation.commit.body");
  const commit = {
    subject: renderTemplate(policy.commit.subject, vars),
    ...(policy.commit.body === undefined ? {} : { body: renderTemplate(policy.commit.body, vars) }),
  };
  const gates = {
    package: renderGates(policy.gates.package, "package", vars),
    project: renderGates(policy.gates.project, "project", vars),
    workspace: renderGates(policy.gates.workspace, "workspace", vars),
  };
  if (gates.package.length + gates.project.length + gates.workspace.length === 0) {
    throw new ConfigError("preparation policy must render at least one repository gate; refusing to certify zero gates");
  }
  return { commit, gates };
}

/**
 * Apply/simulation use this after structural manifest validation. A plan must
 * exactly match the gates and commit metadata that its resolved config renders;
 * otherwise a hand-edited manifest could drop a required repository gate.
 */
export function assertPreparationPolicyMatches(
  config: MonocarveConfig,
  input: PreparationPolicyRenderInput,
  actual: RenderedPreparationPolicy,
): void {
  const expected = renderPreparationPolicy(config, input);
  if (!samePolicy(expected, actual)) {
    throw new ConfigError("preparation manifest policy differs from the exact gates or commit metadata rendered by the resolved configuration");
  }
}

function renderGates(
  templates: readonly string[] | undefined,
  tier: string,
  vars: Readonly<Record<(typeof PREPARATION_PLACEHOLDERS)[number], string>>,
): string[] {
  if (templates === undefined) return [];
  const rendered = templates.map((template) => {
    validateTemplates(template, `preparation.gates.${tier}`);
    return renderTemplate(template, vars);
  }).sort(byCodeUnit);
  if (new Set(rendered).size !== rendered.length) {
    throw new ConfigError(`preparation.gates.${tier} renders duplicate commands; each repository gate must be distinct`);
  }
  return rendered;
}

function validateTemplates(template: string, field: string): void {
  const unknown = templatePlaceholders(template).filter((placeholder) => !PREPARATION_PLACEHOLDERS.includes(placeholder as never));
  if (unknown.length > 0) throw new ConfigError(`${field} contains unsupported preparation placeholder(s): ${unknown.join(", ")}`);
}

function samePolicy(left: RenderedPreparationPolicy, right: RenderedPreparationPolicy): boolean {
  return left.commit.subject === right.commit.subject
    && left.commit.body === right.commit.body
    && sameStrings(left.gates.package, right.gates.package)
    && sameStrings(left.gates.project, right.gates.project)
    && sameStrings(left.gates.workspace, right.gates.workspace);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
