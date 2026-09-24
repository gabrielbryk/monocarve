/**
 * Regenerates the references that are derived from source:
 *   docs/cli-reference.md  from the command registry (src/commands) + scripts/docs/cli-notes.ts
 *   docs/configuration.md  from the zod config schema (src/config/schema*.ts)
 *
 * Run `bun run docs:generate` after changing a command, a flag, or a config key.
 * test/docs-generated.test.ts fails when the committed files differ.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { renderCliReference } from "./cli-reference.ts";
import { renderConfiguration } from "./configuration.ts";
import { formatMarkdown, REPO_ROOT } from "./markdown.ts";

/** Repo-relative path → exact committed contents. */
export function generatedDocs(): ReadonlyMap<string, string> {
  return new Map([
    ["docs/cli-reference.md", formatMarkdown(renderCliReference(), "docs/cli-reference.md")],
    ["docs/configuration.md", formatMarkdown(renderConfiguration(), "docs/configuration.md")],
  ]);
}

if (import.meta.main) {
  for (const [path, contents] of generatedDocs()) {
    writeFileSync(resolve(REPO_ROOT, path), contents);
    console.log(`wrote ${path}`);
  }
}
