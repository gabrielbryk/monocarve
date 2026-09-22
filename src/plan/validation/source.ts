import { isSourceModulePath } from "../../util/files.ts";
import { isSha256 } from "../../util/hash.ts";
import { testKindOf } from "../../config.ts";
import type { ExtractionManifest } from "../manifest.ts";
import type { ValidatePlanOptions } from "./shared.ts";
import { Issues } from "./shared.ts";

export function validateSource(
  manifest: ExtractionManifest,
  options: ValidatePlanOptions,
  issues: Issues,
  containedPath: (path: string, rule: string) => boolean,
): { readonly files: readonly string[]; readonly tests: readonly string[]; readonly assets: readonly string[]; readonly blobs: Readonly<Record<string, string>> } {
  const files = manifest.source?.files ?? [];
  const tests = manifest.source?.tests ?? [];
  const assets = manifest.source?.assets ?? [];
  const declared = [...files, ...tests, ...assets];
  if (assets.some((asset) => isSourceModulePath(asset, options.config.sourceExtensions))) issues.add("asset-kind", "source.assets must not contain configured source modules");
  if (new Set(declared).size !== declared.length) issues.add("source-uniqueness", "source files, tests, and assets must be unique");
  for (const path of declared) containedPath(path, "source-path");
  if (!options.offline) {
    for (const test of tests) {
      const kind = testKindOf(options.config, test);
      const allowed = manifest.integrationTestSuite ? kind === "integration" || kind === undefined : kind === "unit";
      if (!allowed) issues.add("test-kind", `moved test has an invalid relocation kind: ${test}`, { path: test });
    }
  }
  const sccMembers = Object.values(manifest.source?.sccs ?? {}).flat();
  if (new Set(sccMembers).size !== files.length || sccMembers.some((member) => !files.includes(member))) {
    issues.add("scc-partition", "sccs must partition production source files and exclude tests and assets");
  }
  const blobs = manifest.sourceBlobs ?? {};
  if (Object.keys(blobs).length !== declared.length || declared.some((path) => !(path in blobs))) {
    issues.add("source-blobs", "sourceBlobs must cover every source, test, and asset exactly");
  }
  for (const [path, hash] of Object.entries(blobs)) {
    if (!isSha256(hash)) issues.add("source-blobs", `sourceBlobs.${path} must be a SHA-256 hash`, { path });
  }
  return { files, tests, assets, blobs };
}
