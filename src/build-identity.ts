import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { TOOL_VERSION } from "./branding.ts";
import { byCodeUnit, hashText, type Sha256 } from "./util/hash.ts";

declare const __MONOCARVE_BUILD_INTEGRITY__: string | undefined;
declare const __MONOCARVE_SOURCE_REVISION__: string | undefined;
declare const __MONOCARVE_PACKAGING_MODE__: string | undefined;

export interface CompilerBuildIdentity {
  readonly artifactIntegrity: Sha256;
  readonly sourceRevision?: string;
}

export type PackagingMode = "source" | "dist-source" | "standalone-bun";

/** Rich executable provenance for assessment evidence; never plan authority. */
export interface ExecutableBuildIdentity {
  readonly schemaVersion: 1;
  readonly semanticVersion: string;
  readonly packagingMode: PackagingMode;
  readonly compiler: CompilerBuildIdentity;
}

let developmentIdentity: CompilerBuildIdentity | undefined;

/** Build-stamped for distributions; canonical over tool-owned source bytes in development. */
export function compilerBuildIdentity(): CompilerBuildIdentity {
  const stampedIntegrity = typeof __MONOCARVE_BUILD_INTEGRITY__ === "string" ? __MONOCARVE_BUILD_INTEGRITY__ : undefined;
  const sourceRevision = typeof __MONOCARVE_SOURCE_REVISION__ === "string" ? __MONOCARVE_SOURCE_REVISION__ : undefined;
  if (stampedIntegrity === undefined && sourceRevision === undefined && developmentIdentity !== undefined) return developmentIdentity;
  const identity: CompilerBuildIdentity = {
    artifactIntegrity: stampedIntegrity ?? sourceTreeIntegrity(resolve(import.meta.dir)),
    ...(sourceRevision === undefined || sourceRevision === "" ? {} : { sourceRevision }),
  };
  if (stampedIntegrity === undefined && sourceRevision === undefined) developmentIdentity = identity;
  return identity;
}

export function executableBuildIdentity(): ExecutableBuildIdentity {
  return executableBuildIdentityFor(packagingMode());
}

/** Explicit mode constructor keeps distribution identity testable without changing plan provenance. */
export function executableBuildIdentityFor(mode: PackagingMode): ExecutableBuildIdentity {
  return { schemaVersion: 1, semanticVersion: TOOL_VERSION, packagingMode: mode, compiler: compilerBuildIdentity() };
}

export function sourceTreeIntegrity(sourceRoot: string): Sha256 {
  const paths = sourceFiles(sourceRoot).sort(byCodeUnit);
  const canonical = paths
    .map((path) => {
      const relativePath = relative(sourceRoot, path).replaceAll("\\", "/");
      const contents = readFileSync(path, "utf8");
      return `${relativePath.length}:${relativePath}${contents.length}:${contents}`;
    })
    .join("");
  return hashText(canonical);
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

function packagingMode(): PackagingMode {
  const stamped = typeof __MONOCARVE_PACKAGING_MODE__ === "string" ? __MONOCARVE_PACKAGING_MODE__ : undefined;
  return stamped === "dist-source" || stamped === "standalone-bun" ? stamped : "source";
}
