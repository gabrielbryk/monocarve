import { resolve } from "node:path";

import { isFirstPartyPackageOwner, isPackageOwner } from "../../config.ts";
import { readManifest } from "../../graph/workspace.ts";
import type { ExtractionManifest } from "../manifest.ts";
import type { ValidatePlanOptions } from "./shared.ts";
import { Issues } from "./shared.ts";

export function validateDependencies(manifest: ExtractionManifest, options: ValidatePlanOptions, issues: Issues): void {
  validateDependencySections(manifest, options, issues);
  validatePackageReferences(manifest, options, issues);
}

function validateDependencySections(manifest: ExtractionManifest, options: ValidatePlanOptions, issues: Issues): void {
  for (const section of ["runtime", "dev"] as const) {
    for (const [name, version] of Object.entries(manifest.dependencies?.[section] ?? {})) {
      if (!/^[a-zA-Z0-9_.@/-]+$/.test(name) || typeof version !== "string" || version === "") issues.add("dependency", `invalid dependency ${name}`);
      if (isPackageOwner(options.config, name)) issues.add("dependency", `dependency must use a package name, not a directory: ${name}`);
    }
  }
}

function validatePackageReferences(manifest: ExtractionManifest, options: ValidatePlanOptions, issues: Issues): void {
  const references = manifest.dependencies?.packageReferences ?? [];
  if (new Set(references).size !== references.length) issues.add("package-references", "packageReferences must be unique");
  for (const reference of references) {
    if (!isPackageOwner(options.config, reference) && !isFirstPartyPackageOwner(options.config, reference)) {
      issues.add("package-references", `package reference must be a workspace package directory: ${reference}`);
      continue;
    }
    if (!options.offline && !readManifest(resolve(options.rootDir, reference, "package.json"))) {
      issues.add("package-references", `package reference does not exist: ${reference}`);
    }
  }
}
