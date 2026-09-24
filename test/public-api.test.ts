/**
 * The published programmatic surface is `monocarve/config`, and the root `.`
 * export is an alias of it. Both snapshots below are exhaustive on purpose:
 * adding, renaming, or removing a public symbol must be a deliberate edit to
 * this file, never a side effect of re-exporting an internal module.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { z } from "zod";

import * as facade from "../src/config.ts";

const root = resolve(import.meta.dir, "..");
const FACADE = resolve(root, "src/config.ts");

const RUNTIME_EXPORTS = [
  "applicationFor",
  "applicationOwner",
  "assertPreparationPolicyMatches",
  "configDigest",
  "defineConfig",
  "domainFor",
  "findConfigFile",
  "firstPartyRoots",
  "getApplication",
  "isApplicationOwner",
  "isAssetPath",
  "isFirstPartyPackageOwner",
  "isFirstPartyPackagePath",
  "isGuardedBranch",
  "isPackageOwner",
  "isTestPath",
  "loadConfig",
  "monocarveConfigSchema",
  "movableRoots",
  "ownerFor",
  "packageContainerRoots",
  "packageNameMatcher",
  "packageNameOf",
  "parseConfig",
  "renderExtractionProfile",
  "renderPreparationPolicy",
  "resolveExtractionProfile",
  "scaffoldFor",
  "scopedPackageName",
  "testKindOf",
  "testMatchers",
  "triggeredArtifacts",
  "triggeredPathMigrations",
  "triggeredPostJournalPreparers",
];

const TYPE_EXPORTS = [
  "ApplicationConfig",
  "AssetEmissionProofConfig",
  "CommitTemplatesConfig",
  "ExtractionProfileConfig",
  "FirstPartyPackageConfig",
  "GatesConfig",
  "GeneratedArtifactConfig",
  "GeneratedArtifactsConfig",
  "GeneratedSourceAdoptionsConfig",
  "GraphConfig",
  "IntegrationTestSuiteConfig",
  "LoadConfigOptions",
  "LoadedConfig",
  "ModulePromotionsConfig",
  "MonocarveConfig",
  "MonocarveUserConfig",
  "PathMigrationConfig",
  "PathMigrationsConfig",
  "PathReferenceRewritesConfig",
  "PathReferencesConfig",
  "PortfolioConfig",
  "PostJournalPreparerConfig",
  "PreparationCommitTemplateConfig",
  "PreparationGateTemplatesConfig",
  "PreparationPolicyConfig",
  "PreparationPolicyRenderInput",
  "PreparerConfig",
  "PublicSurfaceConfig",
  "RenderedExtractionProfile",
  "RenderedPreparationPolicy",
  "ResolvedExtractionProfile",
  "RuntimeModuleRegistriesConfig",
  "ScaffoldTemplatesConfig",
  "TemplateSource",
  "TestKind",
  "TestKindsConfig",
  "TestRelocationConfig",
  "TransactionConfig",
  "ValueSplitsConfig",
];

function declaredExportNames(): string[] {
  const program = ts.createProgram([FACADE], {
    allowImportingTsExtensions: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    types: [],
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(FACADE);
  const moduleSymbol = source === undefined ? undefined : checker.getSymbolAtLocation(source);
  if (moduleSymbol === undefined) throw new Error("public facade did not type-check as a module");
  return checker
    .getExportsOfModule(moduleSymbol)
    .map((symbol) => symbol.name)
    .toSorted();
}

describe("public API", () => {
  test("the root export is an alias of ./config and nothing else is published", () => {
    const manifest = z.object({ exports: z.record(z.string(), z.unknown()) }).parse(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")));
    const facadeTarget = { types: "./dist/types/config.d.ts", import: "./dist/config.js", default: "./dist/config.js" };
    expect(manifest.exports).toEqual({ ".": facadeTarget, "./config": facadeTarget });
  });

  test("runtime exports match the reviewed snapshot exactly", () => {
    expect(Object.keys(facade).toSorted()).toEqual(RUNTIME_EXPORTS);
  });

  test("declared exports (values and types) match the reviewed snapshot exactly", () => {
    expect(declaredExportNames()).toEqual([...RUNTIME_EXPORTS, ...TYPE_EXPORTS].toSorted());
  });
});
