/** Format generated repository text with the repository's optional Prettier. */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { basename, extname, resolve } from "node:path";

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
  return result.stdout;
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
      return require.resolve(specifier);
    } catch {
      // Prettier is deliberately optional; the deterministic renderer remains
      // the fallback for workspaces that do not install a formatter.
    }
  }
  return undefined;
}
