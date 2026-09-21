/**
 * Where a moved file lands inside the target package.
 *
 * By default a move preserves the path it had below its application source
 * root, so the package mirrors the application and the move reads as a rename.
 * That default is wrong for a package whose own convention is flatter than the
 * application it is being extended from: extending a package laid out as a flat
 * `src/` with a file that lived at `<app>/build/detect.ts` would otherwise
 * force `src/build/detect.ts` and quietly introduce a directory the package
 * does not use.
 *
 * `targetSubpath` is the reviewer-declared override for exactly that: an
 * explicit destination directory inside the package, into which the selected
 * files land by basename. It is recorded on the plan target, so it is part of
 * the reviewed and approved bytes rather than an invocation detail — a refresh
 * that lost it would change every move target, which `refresh` compares as
 * target identity.
 *
 * Every path here is expressed as a *module path*: the package-relative path
 * below the package's source directory. That is the same value the public
 * surface templates and the generated barrel already consume, so a subpath
 * changes one derivation rather than four.
 */

import { basename } from "node:path";

import { PlanningError } from "./context.ts";

/**
 * The package's source directory.
 *
 * Not a workspace fact but this tool's own scaffold layout: every generated
 * package roots its modules here, and the public-surface and barrel templates
 * are written against it. Named once so a subpath is validated against the
 * same string the target paths are built from.
 */
export const PACKAGE_SOURCE_DIR = "src";

/** Minimal view of `WorkspaceContext` this module needs, so validation can share it. */
export interface TargetRelativeResolver {
  targetRelativePath(source: string): string;
}

/**
 * Normalize and refuse a caller-supplied destination subpath.
 *
 * Refusals are deliberate rather than best-effort repairs: a subpath that
 * escapes the package, or that lands outside the package source directory the
 * scaffold templates render against, would produce a package whose declared
 * exports do not name the files the journal moved.
 */
export function normalizeTargetSubpath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const segments = normalized.split("/");
  if (normalized === "" || normalized.startsWith("/")) {
    throw new PlanningError(`--target-subpath must be a non-empty package-relative directory: ${JSON.stringify(value)}`);
  }
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new PlanningError(`--target-subpath must not contain empty, "." or ".." segments: ${JSON.stringify(value)}`);
  }
  if (normalized !== PACKAGE_SOURCE_DIR && !normalized.startsWith(`${PACKAGE_SOURCE_DIR}/`)) {
    throw new PlanningError(
      `--target-subpath must be ${PACKAGE_SOURCE_DIR} or a directory below it, because the package's exports and barrel are rendered from ${PACKAGE_SOURCE_DIR}: ${JSON.stringify(value)}`,
    );
  }
  return normalized;
}

/**
 * Package-relative path below {@link PACKAGE_SOURCE_DIR} for one moved source.
 *
 * With no subpath this is the structure-preserving default. With one, the file
 * lands directly in the requested directory under its own basename; two
 * selected files that would collide there are refused by the caller's existing
 * duplicate-target check rather than silently overwriting one another.
 */
export function packageModulePath(
  context: TargetRelativeResolver,
  source: string,
  targetSubpath: string | undefined,
): string {
  if (targetSubpath === undefined) return context.targetRelativePath(source);
  const normalized = normalizeTargetSubpath(targetSubpath);
  const below = normalized === PACKAGE_SOURCE_DIR ? "" : normalized.slice(PACKAGE_SOURCE_DIR.length + 1);
  const name = basename(source);
  return below === "" ? name : `${below}/${name}`;
}

/** Absolute-in-workspace target path for a module path. */
export function packageTargetPath(packageRoot: string, modulePath: string): string {
  return `${packageRoot}/${PACKAGE_SOURCE_DIR}/${modulePath}`;
}
