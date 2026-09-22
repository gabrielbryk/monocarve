import { readFileSync, statSync } from "node:fs";

import { fileState } from "../util/files.ts";
import { git, repositoryPrefix, showBaseline, statusEntries } from "../util/git.ts";
import { byCodeUnit, hashJson, hashText } from "../util/hash.ts";
import { workspacePath } from "../util/paths.ts";
import { PreparerError } from "./core.ts";
import type { PreparerManifest, PreparerMutation } from "./manifest.ts";

/** Bind an introducing dirty config's exact committed preimage and reviewed result to a plan. */
export function bindBootstrapConfig(rootDir: string, manifest: PreparerManifest, path: string): PreparerManifest {
  workspacePath(rootDir, path);
  const dirty = unique(statusEntries(rootDir).flatMap((entry) => entry.paths));
  if (dirty.length !== 1 || dirty[0] !== path)
    throw new PreparerError(`bootstrap planning requires exactly the dirty config path; found: ${dirty.join(", ") || "(none)"}`);
  const baselineContents = showBaseline(rootDir, manifest.baseline.commit, path);
  if (baselineContents === null) throw new PreparerError(`bootstrap config must already exist at baseline: ${path}`);
  const contents = readFileSync(workspacePath(rootDir, path), "utf8");
  const tree = git({ cwd: rootDir }, "ls-tree", manifest.baseline.commit, "--", `${repositoryPrefix(rootDir)}${path}`);
  const bootstrapConfig: PreparerMutation = {
    path,
    preconditionHash: hashText(baselineContents),
    preconditionMode: Number.parseInt((tree.split(" ")[0] ?? "").slice(-3), 8),
    resultHash: fileState(workspacePath(rootDir, path)),
    resultMode: (statSync(workspacePath(rootDir, path)).mode & 0o111) === 0 ? 0o644 : 0o755,
    contents,
  };
  const { planId: _planId, ...draft } = manifest;
  return { ...draft, bootstrapConfig, planId: hashJson({ ...draft, bootstrapConfig }) };
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)].sort(byCodeUnit);
}
