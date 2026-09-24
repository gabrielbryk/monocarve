/**
 * Placeholder substitution for every user-supplied template in the config:
 * gate commands, commit subjects, and package scaffold files.
 *
 * Syntax is intentionally trivial — `{name}` — because these templates are
 * config, not a programming surface. Unknown placeholders are an error rather
 * than a silent empty string: a gate command that quietly loses its target is
 * worse than one that refuses to run.
 */

import { MonocarveError } from "../errors.ts";

export type TemplateVars = Readonly<Record<string, string>>;

const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;

class TemplateError extends MonocarveError {
  override readonly name = "TemplateError";
}

export function renderTemplate(template: string, vars: TemplateVars): string {
  return template.replace(PLACEHOLDER, (_match, key: string) => {
    const value = vars[key];
    if (value === undefined) {
      throw new TemplateError(
        `unknown placeholder {${key}} in template ${JSON.stringify(template)}; known: ${Object.keys(vars).toSorted().join(", ") || "(none)"}`,
      );
    }
    return value;
  });
}

/** Placeholder names referenced by a template, for validation and docs. */
export function templatePlaceholders(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name !== undefined) found.add(name);
  }
  return [...found].toSorted();
}
