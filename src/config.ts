/**
 * Public configuration API.
 *
 * The schema is intentionally split by responsibility. This facade preserves
 * the stable import path used by the engine and by workspace configuration.
 */

export { triggeredArtifacts, triggeredPathMigrations } from "./config/schema-artifacts.ts";
export type {
  AssetEmissionProofConfig,
  GeneratedArtifactConfig,
  GeneratedArtifactsConfig,
  PathMigrationConfig,
  PathMigrationsConfig,
  PostJournalPreparerConfig,
  TransactionConfig,
} from "./config/schema-artifacts.ts";
export type {
  ApplicationConfig,
  CommitTemplatesConfig,
  ExtractionProfileConfig,
  FirstPartyPackageConfig,
  GatesConfig,
  PreparationCommitTemplateConfig,
  PreparationGateTemplatesConfig,
  PreparationPolicyConfig,
  PreparerConfig,
  RenderedExtractionProfile,
  ResolvedExtractionProfile,
  ScaffoldTemplatesConfig,
} from "./config/schema-core.ts";
export {
  assertPreparationPolicyMatches,
  renderPreparationPolicy,
} from "./config/preparation.ts";
export type {
  PreparationPolicyRenderInput,
  RenderedPreparationPolicy,
} from "./config/preparation.ts";
export {
  applicationFor,
  applicationOwner,
  domainFor,
  firstPartyRoots,
  getApplication,
  isApplicationOwner,
  isAssetPath,
  isFirstPartyPackageOwner,
  isFirstPartyPackagePath,
  isGuardedBranch,
  isPackageOwner,
  isTestPath,
  movableRoots,
  ownerFor,
  packageNameMatcher,
  packageNameOf,
  scopedPackageName,
  testKindOf,
  testMatchers,
} from "./config/helpers.ts";
export { findConfigFile, loadConfig, parseConfig } from "./config/loading.ts";
export type { LoadedConfig, LoadConfigOptions } from "./config/loading.ts";
export { renderExtractionProfile, resolveExtractionProfile, scaffoldFor } from "./config/profiles.ts";
export type { PublicSurfaceConfig, TemplateSource } from "./config/primitives.ts";
export type {
  GraphConfig,
  IntegrationTestSuiteConfig,
  GeneratedSourceAdoptionsConfig,
  ModulePromotionsConfig,
  ValueSplitsConfig,
  PathReferencesConfig,
  RuntimeModuleRegistriesConfig,
  PortfolioConfig,
  TestKind,
  TestKindsConfig,
  TestRelocationConfig,
} from "./config/schema-policy.ts";
export { defineConfig, monocarveConfigSchema } from "./config/schema.ts";
export type { MonocarveConfig, MonocarveUserConfig } from "./config/schema.ts";
