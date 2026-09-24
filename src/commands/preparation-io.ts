import { readFileSync } from "node:fs";
import { dirname, relative } from "node:path";

import { IoError, UsageError } from "../errors.ts";
import { workspacePath } from "../util/paths.ts";
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

export function parseJsonObject(text: string, path: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`could not parse ${label} ${path}: ${systemReason(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError(`${label} ${path} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}
