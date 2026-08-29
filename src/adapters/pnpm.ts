/** pnpm adapter facade. Lockfile grammar lives in focused sibling modules. */

import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import type { LockfileImporterMode } from "../plan/manifest.ts";
import { hashText, type Sha256 } from "../util/hash.ts";
import { relativePosix } from "../util/paths.ts";
import { declaredPackageManagerVersion } from "./package-manager-version.ts";
import { deleteImporter, importerBlock, insertImporter, replaceImporter } from "./pnpm-importers.ts";
import { addBlockDependencies, addBlockDependency, removeBlockDependency, renderImporterBlock } from "./pnpm-render.ts";
import { missingResolutions } from "./pnpm-resolutions.ts";
import { listPackages, workspaceManifestEdit } from "./pnpm-workspace.ts";
import type { PackageManagerAdapter } from "./types.ts";

export { LockfileError } from "./pnpm-error.ts";
export { parseImporters } from "./pnpm-importers.ts";

const LOCKFILE_NAME = "pnpm-lock.yaml";
const WORKSPACE_MANIFEST = "pnpm-workspace.yaml";

export const pnpmAdapter: PackageManagerAdapter = {
  id: "pnpm",
  contractVersion: 1,
  declaredVersion: (text) => declaredPackageManagerVersion(text, "pnpm"),
  lockfileName: LOCKFILE_NAME,
  workspaceManifestName: WORKSPACE_MANIFEST,
  listPackages: (rootDir) => listPackages(rootDir, WORKSPACE_MANIFEST),
  renderImporterBlock: (input) => renderImporterBlock(input, pnpmAdapter.linkVersion),
  importerBlock,
  blockDeclaresImporter: (block, root) => block.includes(`  ${root}:`),
  insertImporter,
  replaceImporter,
  applyImporter: (text, root, block, mode) => applyImporter(text, root, block, mode),
  missingResolutions,
  lockfileImporterHash: (text, root) => importerHash(text, root),
  addBlockDependency,
  addBlockDependencies: (block, input) => addBlockDependencies(block, input, pnpmAdapter.linkVersion),
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

function importerHash(text: string, root: string): Sha256 | undefined {
  const block = importerBlock(text, root);
  return block === undefined ? undefined : hashText(block);
}

/** Workspace-relative lockfile location for operation declarations. */
export function lockfilePath(adapter: PackageManagerAdapter): string {
  return adapter.lockfileName;
}

/** Read an adapter-owned lockfile when it exists. */
export function readLockfile(rootDir: string, adapter: PackageManagerAdapter): string | undefined {
  const path = resolve(rootDir, adapter.lockfileName);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** `relative()` normalized for manifest paths and lockfile links. */
export function posixRelative(from: string, to: string): string {
  return relative(from, to).replaceAll("\\", "/");
}
