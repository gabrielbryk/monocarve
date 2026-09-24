import { readFileSync } from "node:fs";
import { dirname, relative } from "node:path";

import { flagString, type ParsedArgs } from "../cli/args.ts";
import { IoError, UsageError } from "../errors.ts";
import { assertPreparationManifestValid, type PreparationManifest } from "../prepare/index.ts";
import { parseJsonObject } from "../util/json.ts";
import { relativeWorkspacePath, workspacePath } from "../util/paths.ts";
import { systemReason } from "./shared.ts";

export function relativeTypeSpecifier(fromPath: string, resolvedSourcePath: string, originalSpecifier: string): string {
  let destination = resolvedSourcePath;
  const originalExtension = originalSpecifier.match(/(\.[^./]+)$/)?.[1];
  const resolvedExtension = resolvedSourcePath.match(/(\.[^./]+)$/)?.[1];
  if (originalExtension === undefined && resolvedExtension !== undefined) destination = resolvedSourcePath.slice(0, -resolvedExtension.length);
  else if (originalExtension !== undefined && resolvedExtension !== undefined)
    destination = `${resolvedSourcePath.slice(0, -resolvedExtension.length)}${originalExtension}`;
  const specifier = relative(dirname(fromPath), destination).replaceAll("\\", "/");
  return specifier.startsWith(".") ? specifier : `./${specifier}`;
}

export function readWorkspaceText(rootDir: string, path: string, label: string): string {
  try {
    return readFileSync(workspacePath(rootDir, path), "utf8");
  } catch (error) {
    throw new IoError(`could not read ${label} ${path}: ${systemReason(error)}`);
  }
}

export function requiredFlag(args: ParsedArgs, name: string): string {
  const value = flagString(args, name);
  if (value === undefined) throw new UsageError(`--${name} <value> is required`);
  return value;
}

export function loadPreparationManifest(args: ParsedArgs, rootDir: string): { path: string; manifest: PreparationManifest } {
  const input = flagString(args, "plan") ?? args.positionals[0];
  if (input === undefined) throw new UsageError("a preparation plan path is required (--plan <path>)");
  const path = relativeWorkspacePath(rootDir, input);
  const parsed = parseJsonObject(readWorkspaceText(rootDir, path, "preparation plan"), path, "preparation plan");
  if ("preparer" in parsed && !("operations" in parsed)) {
    throw new UsageError(`preparation plan ${path} is a preparer manifest; use preparer-apply --plan ${path} (then preparer-commit) instead`);
  }
  if (!("operations" in parsed)) {
    throw new UsageError(`preparation plan ${path} is missing its operations array; refusing to interpret an unknown schema as a declaration-preparation plan`);
  }
  const manifest = parsed as unknown as PreparationManifest;
  assertPreparationManifestValid(manifest);
  return { path, manifest };
}
