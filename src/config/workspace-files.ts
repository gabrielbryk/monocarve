/**
 * Workspace files each supported package manager owns. Config loading needs
 * them before an adapter is selected (they are resolver inputs to executable
 * config), so they live below the adapters that also use them.
 */
export const PACKAGE_MANAGER_FILES = {
  bun: { lockfile: "bun.lock", workspaceManifest: "package.json" },
  pnpm: { lockfile: "pnpm-lock.yaml", workspaceManifest: "pnpm-workspace.yaml" },
} as const;
