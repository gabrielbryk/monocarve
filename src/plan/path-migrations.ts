/** Execute one configured path-key migration as a deterministic text filter. */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";

import { PATH_MIGRATION_TMP_PREFIX } from "../branding.ts";
import { scrubbedGitEnv } from "../util/git.ts";
import { stableStringify } from "../util/hash.ts";
import { ensureScratchDir } from "../util/scratch-root.ts";
import type { MigratePathKeysOperation, PathMove } from "./manifest.ts";

const OUTPUT_TAIL = 4000;

export interface PathMigrationInput {
  readonly artifact: string;
  readonly contents: string;
  readonly moves: readonly PathMove[];
}

/**
 * Run a migration command in an isolated disposable working directory.
 *
 * The config owns the command; the engine passes data only through stdin. A
 * relative write therefore lands in the disposable directory and is removed
 * even when the command fails. Commands must be self-contained and resolvable
 * through `PATH`; config is trusted code, not a hostile-code sandbox.
 */
export function runPathMigrationCommand(
  _root: string,
  operation: Pick<MigratePathKeysOperation, "path" | "command" | "moves">,
  contents: string,
  timeoutMs: number,
): string {
  const request: PathMigrationInput = { artifact: operation.path, contents, moves: operation.moves };
  const commandRoot = mkdtempSync(ensureScratchDir(PATH_MIGRATION_TMP_PREFIX));
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync(["sh", "-c", operation.command], {
      cwd: commandRoot,
      env: scrubbedGitEnv(),
      stdin: Buffer.from(`${stableStringify(request)}\n`, "utf8"),
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
    });
  } finally {
    rmSync(commandRoot, { recursive: true, force: true });
  }

  const exitCode = result.exitCode ?? 1;
  if (exitCode !== 0) {
    const signal = result.signalCode ? `killed by ${result.signalCode} after ${timeoutMs}ms\n` : "";
    const output = `${signal}${result.stderr?.toString() ?? ""}`.trimEnd().slice(-OUTPUT_TAIL);
    throw new Error(`path migration ${operation.path} failed (exit ${exitCode}): ${operation.command}` + (output === "" ? "" : `\n${output}`));
  }
  if (result.stdout === undefined) throw new Error(`path migration ${operation.path} produced no captured stdout`);
  return decodeUtf8(result.stdout, `path migration output for ${operation.path}`);
}

/** Read an artifact without silently replacing malformed UTF-8 bytes. */
export function readUtf8Artifact(path: string, displayPath: string): string {
  return decodeUtf8(readFileSync(path), `path-keyed artifact ${displayPath}`);
}

function decodeUtf8(bytes: Uint8Array, subject: string): string {
  try {
    // `ignoreBOM: true` means the decoder does not consume the leading BOM as
    // metadata; it returns U+FEFF, so UTF-8 re-encoding preserves the bytes.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${subject} is not valid UTF-8 text`);
  }
}
