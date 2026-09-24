import type { LoadedConfig } from "../config.ts";
export { InputInventoryError } from "../errors.ts";

export interface CaptureInventoryOptions extends Pick<LoadedConfig, "config" | "configPath" | "rootDir"> {
  /** Validated operational paths excluded only after overlap checks. */
  readonly excludedRoots?: readonly string[];
  /** Files exposed to executable config before its config-driven roots existed. */
  readonly configSnapshotPaths?: readonly string[];
}
