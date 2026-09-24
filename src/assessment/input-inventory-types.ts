import type { LoadedConfig } from "../config.ts";
import { MonocarveError } from "../errors.ts";

export class InputInventoryError extends MonocarveError {
  override readonly name = "InputInventoryError";
  constructor(
    readonly code: "ASSESSMENT_INPUT_DRIFT" | "ASSESSMENT_INPUT_UNBOUND",
    message: string,
    readonly paths: readonly string[],
  ) {
    super(message);
  }
}

export interface CaptureInventoryOptions extends Pick<LoadedConfig, "config" | "configPath" | "rootDir"> {
  /** Validated operational paths excluded only after overlap checks. */
  readonly excludedRoots?: readonly string[];
  /** Files exposed to executable config before its config-driven roots existed. */
  readonly configSnapshotPaths?: readonly string[];
}
