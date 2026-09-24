/** pnpm adapter facade. Lockfile grammar lives in focused sibling modules. */

import { PACKAGE_MANAGER_FILES } from "../config/workspace-files.ts";
import { relativePosix } from "../util/paths.ts";
import { importerHasher } from "./importer-hash.ts";
import { declaredPackageManagerVersion } from "./package-manager-version.ts";
import { deleteImporter, importerBlock, insertImporter, replaceImporter } from "./pnpm-importers.ts";
import { addBlockDependencies, addBlockDependency, removeBlockDependency, renderImporterBlock } from "./pnpm-render.ts";
import { missingResolutions } from "./pnpm-resolutions.ts";
import { inspectWorkspace, listPackages, workspaceManifestEdit } from "./pnpm-workspace.ts";
import type { LockfileImporterMode, PackageManagerAdapter } from "./types.ts";

export { LockfileError } from "./pnpm-error.ts";

const LOCKFILE_NAME = PACKAGE_MANAGER_FILES.pnpm.lockfile;
const WORKSPACE_MANIFEST = PACKAGE_MANAGER_FILES.pnpm.workspaceManifest;

export const pnpmAdapter: PackageManagerAdapter = {
  id: "pnpm",
  contractVersion: 1,
  declaredVersion: (text) => declaredPackageManagerVersion(text, "pnpm"),
  lockfileName: LOCKFILE_NAME,
  workspaceManifestName: WORKSPACE_MANIFEST,
  listPackages: (rootDir) => listPackages(rootDir, WORKSPACE_MANIFEST),
  inspectWorkspace: (rootDir) => inspectWorkspace(rootDir, WORKSPACE_MANIFEST),
  renderImporterBlock: (input) => renderImporterBlock(input, (fromRoot, toRoot) => pnpmAdapter.linkVersion(fromRoot, toRoot)),
  importerBlock,
  blockDeclaresImporter: (block, root) => block.includes(`  ${root}:`),
  insertImporter,
  replaceImporter,
  applyImporter: (text, root, block, mode) => applyImporter(text, root, block, mode),
  missingResolutions,
  lockfileImporterHash: importerHasher(importerBlock),
  addBlockDependency,
  addBlockDependencies: (block, input) => addBlockDependencies(block, input, (fromRoot, toRoot) => pnpmAdapter.linkVersion(fromRoot, toRoot)),
  removeBlockDependency,
  linkVersion: (fromRoot, toRoot) => `link:${relativePosix(fromRoot, toRoot)}`,
  workspaceManifestEdit,
  installCommand: () => ["pnpm", "install", "--frozen-lockfile"],
  lockfileOnlyCommand: () => ["pnpm", "install", "--lockfile-only"],
};

function applyImporter(text: string, root: string, block: string, mode?: LockfileImporterMode): string {
  if (mode === "delete") return deleteImporter(text, root);
  return mode === "replace" ? replaceImporter(text, root, block) : insertImporter(text, root, block);
}
