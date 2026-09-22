/** Format generated repository text with the repository's optional Prettier. */

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";

import { PlanningError } from "./context.ts";

const PRETTIER_EXTENSIONS = new Set([
  ".cjs", ".cts", ".css", ".html", ".js", ".json", ".json5", ".jsonc", ".jsx", ".md", ".mjs", ".mts", ".scss", ".ts", ".tsx", ".yaml", ".yml",
]);

/**
 * Use a workspace-owned formatter when it is available, without making it a
 * dependency of MonoCarve itself. Stdin keeps planning read-only, while the
 * virtual filepath lets Prettier select both the parser and repository config.
 */
export function formatGeneratedText(rootDir: string, path: string, contents: string): string {
  if (!PRETTIER_EXTENSIONS.has(extname(path).toLowerCase())) return contents;
  const executable = prettierExecutable(rootDir);
  if (executable === undefined) return contents;
  const result = spawnSync(javascriptRuntime(), [executable, "--stdin-filepath", path], {
    cwd: rootDir,
    input: contents,
    encoding: "utf8",
  });
  if (result.error !== undefined) throw new PlanningError(`Prettier could not format ${path}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}`.trim();
    throw new PlanningError(`Prettier could not format ${path}${detail === "" ? "" : `: ${detail}`}`);
  }
  const formatted = result.stdout ?? "";

  // A successful exit is not a guarantee that the formatter produced a
  // document. A formatter whose stdin never arrived formats an empty input,
  // prints nothing, and exits 0 — bun 1.3.14 does exactly this to a Prettier
  // it launches through `spawnSync`'s `input`. The empty string is then hashed
  // into the plan and written over a real repository file.
  //
  // This raises rather than falling back to `contents`. Both avoid writing the
  // empty file, but a fallback is silent: the operator gets plans whose bytes
  // depend on whether the formatter happened to work, and a broken formatter
  // survives indefinitely because nothing ever reports it. Naming the
  // formatter and the path is the failure an operator can act on, and refusing
  // to emit a plan is the safe answer for a tool whose contract is that a plan
  // it produced is the plan it will apply. Whitespace-only output is covered
  // too: no formatter legitimately reduces a non-blank document to blanks.
  if (contents.trim() !== "" && formatted.trim() === "") {
    throw new PlanningError(`Prettier at ${executable} produced empty output for ${path}; refusing to write an empty generated file`);
  }
  return formatted;
}

/**
 * A compiled Bun executable reports itself as `process.execPath`. That binary
 * is MonoCarve's CLI, not a JavaScript launcher, so passing Prettier's CJS
 * entrypoint to it makes the entrypoint look like an unknown CLI command.
 * Prefer a real runtime from PATH and retain the current executable only when
 * it already is a JS runtime or no runtime lookup is available.
 */
function javascriptRuntime(): string {
  const current = process.execPath;
  const name = basename(current).toLowerCase();
  if (name === "node" || name === "node.exe" || name === "bun" || name === "bun.exe") return current;
  return Bun.which("node") ?? Bun.which("bun") ?? current;
}

function prettierExecutable(rootDir: string): string | undefined {
  const require = createRequire(resolve(rootDir, "package.json"));
  for (const specifier of ["prettier/bin/prettier.cjs", "prettier/bin-prettier.js"]) {
    try {
      const resolved = require.resolve(specifier);
      if (ownedByWorkspace(rootDir, resolved)) return resolved;
    } catch {
      // Prettier is deliberately optional; the deterministic renderer remains
      // the fallback for workspaces that do not install a formatter.
    }
  }
  return undefined;
}

/**
 * Only a formatter the planned workspace installed may shape its files. The
 * resolver is rooted at the workspace's own `package.json`, but resolution
 * does not stop there: Node walks `node_modules` upward out of the workspace,
 * and Bun, finding no `node_modules` at all, auto-installs the specifier into
 * its global cache and resolves that. Either way MonoCarve would format a
 * repository with a formatter and a version that repository never chose — and
 * an uninstalled workspace, the case most likely to have no `node_modules`,
 * is exactly where the surprise lands.
 */
function ownedByWorkspace(rootDir: string, executable: string): boolean {
  return inside(rootDir, executable) || inside(canonical(rootDir), canonical(executable));
}

/**
 * Both the literal and the real path are consulted. A pnpm or Bun workspace
 * reaches its packages through symlinks whose targets are still inside the
 * checkout, while a symlinked workspace root only matches once resolved.
 */
function inside(rootDir: string, executable: string): boolean {
  const step = relative(resolve(rootDir), resolve(executable));
  // `relative` answers "" for the root itself and an absolute path when no
  // relative route exists (a different Windows volume). A leading `..`
  // *segment* is the escape; a sibling literally named `..foo` is not.
  return step !== "" && step !== ".." && !step.startsWith(`..${sep}`) && !isAbsolute(step);
}

/** Resolve a real path, falling back to the literal one when it is unreadable. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
