/**
 * Render the configured per-module package surface.
 *
 * Kept pure so planning and validation can share the same extension and path
 * semantics, and so malformed templates fail before any journal is emitted.
 */

import type { PublicSurfaceConfig } from "../config.ts";
import { renderTemplate } from "../util/template.ts";
import { PlanningError } from "./context.ts";

export interface RenderedPublicModulePath {
  readonly path: string;
  readonly exportKey: string;
  readonly exportTarget: string;
}

export function renderPublicModulePaths(surface: PublicSurfaceConfig, paths: readonly string[]): RenderedPublicModulePath[] {
  if (surface.mode === "barrel") return [];

  const rendered = paths.map((rawPath) => {
    const path = rawPath.replaceAll("\\", "/");
    const vars = { path, pathNoExtension: path.replace(/\.[cm]?[jt]sx?$/, ""), pathJs: path.replace(/\.[cm]?tsx?$/, ".js") };
    const exportKey = renderTemplate(surface.keyTemplate, vars);
    const exportTarget = renderTemplate(surface.targetTemplate, vars);
    assertPackageRelative("key", exportKey);
    assertPackageRelative("target", exportTarget);
    return { path, exportKey, exportTarget };
  });

  if (new Set(rendered.map((entry) => entry.exportKey)).size !== rendered.length) {
    throw new PlanningError("two moved modules render the same public subpath export key");
  }
  if (new Set(rendered.map((entry) => entry.exportTarget)).size !== rendered.length) {
    throw new PlanningError("two moved modules render the same public subpath export target");
  }
  return rendered;
}

function assertPackageRelative(kind: "key" | "target", value: string): void {
  const segments = value.startsWith("./") ? value.slice(2).split("/") : [];
  if (!value.startsWith("./") || value === "./" || value.includes("\\") || segments.some((segment) => segment === "." || segment === "..")) {
    throw new PlanningError(`public subpath ${kind} must stay below the package root: ${value}`);
  }
}
