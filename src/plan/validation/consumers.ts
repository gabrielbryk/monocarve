import type { ExtractionManifest } from "../manifest.ts";
import { validateDonorSurface } from "./operations.ts";
import { Issues } from "./shared.ts";

export function validateConsumers(
  manifest: ExtractionManifest,
  issues: Issues,
  packageName: string,
  publicModules: NonNullable<ExtractionManifest["target"]["publicModules"]>,
  selectedDonors: ReadonlySet<string>,
  containedPath: (path: string, rule: string) => boolean,
): ReadonlySet<string> {
  const consumerFiles = new Set<string>();
  const rewriteTargets = new Set([packageName, ...publicModules.map((module) => module.specifier)]);
  const publicSpecifierByDonor = new Map(publicModules.map((module) => [module.source, module.specifier]));
  for (const consumer of manifest.consumers ?? []) {
    if (!consumer.file) {
      issues.add("consumer", "consumer file must be a non-empty string");
      continue;
    }
    containedPath(consumer.file, "consumer");
    if (consumerFiles.has(consumer.file)) issues.add("consumer", `duplicate consumer ${consumer.file}`);
    consumerFiles.add(consumer.file);
    if (!consumer.expectedImporter) issues.add("consumer", `consumer ${consumer.file} declares no expected importer`);
    if (consumer.dependencySection !== "runtime" && consumer.dependencySection !== "dev") issues.add("consumer", `consumer ${consumer.file} has an invalid dependency section`);
    if (consumer.specifiers.length === 0) issues.add("consumer", `consumer ${consumer.file} declares no rewrite`);
    for (const rewrite of consumer.specifiers) {
      if (!rewriteTargets.has(rewrite.to)) issues.add("consumer", `consumer rewrite must target a declared ${packageName} surface`);
      if (rewrite.from === rewrite.to) issues.add("consumer", `consumer rewrite for ${consumer.file} is a no-op`);
      validateDonorSurface(rewrite, packageName, publicSpecifierByDonor, selectedDonors, issues, "consumer", { path: consumer.file });
    }
  }
  return consumerFiles;
}
