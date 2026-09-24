/** bun adapter facade. Lockfile grammar lives in focused sibling modules. */

import type { LockfileImporterMode } from "../plan/manifest.ts";
import { hashText, type Sha256 } from "../util/hash.ts";
import {
  blockDeclaresImporter,
  deleteImporter,
  importerBlock,
  insertImporter,
  missingResolutions,
  replaceImporter,
} from "./bun-importers.ts";
import { addBlockDependencies, addBlockDependency, removeBlockDependency, renderImporterBlock } from "./bun-render.ts";
import { inspectWorkspace, listPackages, workspaceManifestEdit } from "./bun-workspace.ts";
import { declaredPackageManagerVersion } from "./package-manager-version.ts";
import type { PackageManagerAdapter } from "./types.ts";

export { LockfileError } from "./lockfile-error.ts";
export { parseBunLock } from "./bun-lock.ts";

const LOCKFILE_NAME = "bun.lock";
/**
 * bun has no workspace file of its own: membership is the root manifest's
 * `workspaces` array, so that is the file this adapter registers a new package
 * in. Naming it here rather than returning `null` is what keeps the scaffolder
 * emitting a membership operation — a `null` would make every membership edit
 * silently optional, which for a package root outside the declared globs means
 * a package the workspace never sees.
 */
const WORKSPACE_MANIFEST = "package.json";

export const bunAdapter: PackageManagerAdapter = {
  id: "bun",
  contractVersion: 1,
  declaredVersion: (text) => declaredPackageManagerVersion(text, "bun"),
  lockfileName: LOCKFILE_NAME,
  workspaceManifestName: WORKSPACE_MANIFEST,
  listPackages: (rootDir) => listPackages(rootDir, WORKSPACE_MANIFEST),
  inspectWorkspace: (rootDir) => inspectWorkspace(rootDir, WORKSPACE_MANIFEST),
  renderImporterBlock,
  importerBlock,
  blockDeclaresImporter,
  insertImporter,
  replaceImporter,
  applyImporter: (text, root, block, mode) => applyImporter(text, root, block, mode),
  missingResolutions,
  lockfileImporterHash: (text, root) => importerHash(text, root),
  addBlockDependency,
  addBlockDependencies,
  removeBlockDependency,
  /**
   * bun stores the manifest's own specifier in `workspaces`, so there is no
   * separate resolved column for a link. This is the specifier a manifest would
   * have to carry to name that directory; the splicers write the declared
   * specifier and ignore it.
   */
  linkVersion: (_fromRoot, toRoot) => `workspace:${toRoot}`,
  workspaceManifestEdit,
  installCommand: () => ["bun", "install", "--frozen-lockfile"],
  /**
   * `--lockfile-only` resolves and rewrites `bun.lock` without touching
   * `node_modules`. It is the oracle the opt-in verification compares the
   * splice against — and only that: measured against bun 1.3.14, adding
   * `--frozen-lockfile` does *not* make it refuse a divergent lockfile, it
   * saves the regenerated one anyway. The comparison is the check; the exit
   * code is not.
   */
  lockfileOnlyCommand: () => ["bun", "install", "--lockfile-only"],
};

function applyImporter(text: string, root: string, block: string, mode?: LockfileImporterMode): string {
  if (mode === "delete") return deleteImporter(text, root);
  return mode === "replace" ? replaceImporter(text, root, block) : insertImporter(text, root, block);
}

function importerHash(text: string, root: string): Sha256 | undefined {
  const block = importerBlock(text, root);
  return block === undefined ? undefined : hashText(block);
}
