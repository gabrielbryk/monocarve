/** Format generated repository text with the repository's optional Prettier. */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { extname, resolve } from "node:path";

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
  const result = spawnSync(process.execPath, [executable, "--stdin-filepath", path], {
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
