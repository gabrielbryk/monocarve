/**
 * The ONLY module allowed to branch on `config.packageManager` /
 * `config.taskRunner`. Everything downstream takes an adapter.
 */

import type { MonocarveConfig } from "../config.ts";
import { NotYetPortedError } from "../errors.ts";
import { moonAdapter, noneTaskRunner } from "./moon.ts";
import { pnpmAdapter } from "./pnpm.ts";
import type { PackageManagerAdapter, TaskRunnerAdapter } from "./types.ts";

export function createPackageManagerAdapter(config: MonocarveConfig): PackageManagerAdapter {
  switch (config.packageManager) {
    case "pnpm":
      return pnpmAdapter;
    case "bun":
      throw new NotYetPortedError("adapters/registry: bun package-manager adapter");
    case "npm":
      throw new NotYetPortedError("adapters/registry: npm package-manager adapter");
    case "yarn":
      throw new NotYetPortedError("adapters/registry: yarn package-manager adapter");
  }
}

export function createTaskRunnerAdapter(config: MonocarveConfig): TaskRunnerAdapter {
  switch (config.taskRunner) {
    case "moon":
      return moonAdapter;
    case "none":
      return noneTaskRunner;
    case "nx":
      throw new NotYetPortedError("adapters/registry: nx task-runner adapter");
    case "turbo":
      throw new NotYetPortedError("adapters/registry: turbo task-runner adapter");
  }
}
