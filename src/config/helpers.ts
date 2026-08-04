import { ConfigError } from "../errors.ts";
import type { ApplicationConfig } from "./schema-core.ts";
import type { MonocarveConfig } from "./schema.ts";
import type { TestKind } from "./schema-policy.ts";

export function getApplication(config: MonocarveConfig, name: string): ApplicationConfig {
  const app = config.applications.find((candidate) => candidate.name === name);
  if (!app) {
    const known = config.applications.map((candidate) => candidate.name).join(", ");
    throw new ConfigError(`unknown application ${JSON.stringify(name)}; configured: ${known}`);
  }
  return app;
}

/** Compiled test matchers. Rebuilt per call; callers should hoist in hot loops. */
export function testMatchers(config: MonocarveConfig): RegExp[] {
  return config.testKinds === undefined
    ? config.testPathPatterns.map((source) => new RegExp(source))
    : Object.values(config.testKinds).flat().map((source) => new RegExp(source));
}

export function isTestPath(config: MonocarveConfig, path: string): boolean {
  return testKindOf(config, path) !== undefined;
}

/** Classify a test path without guessing from a filename. Overlap is a refusal. */
export function testKindOf(config: MonocarveConfig, path: string): TestKind | undefined {
  if (config.testKinds === undefined) {
    return config.testPathPatterns.some((source) => new RegExp(source).test(path)) ? "unit" : undefined;
  }
  const matches = (Object.entries(config.testKinds) as [TestKind, string[]][])
    .filter(([, patterns]) => patterns.some((source) => new RegExp(source).test(path)))
    .map(([kind]) => kind);
  if (matches.length > 1) throw new ConfigError(`test path ${JSON.stringify(path)} matches multiple configured test kinds: ${matches.join(", ")}`);
  return matches[0];
}

export function isAssetPath(config: MonocarveConfig, path: string): boolean {
  return config.assetExtensions.some((extension) => path.endsWith(extension));
}

/** Qualify a bare package name with the configured scope. Idempotent. */
export function scopedPackageName(config: MonocarveConfig, bareName: string): string {
  if (!config.packageScope) return bareName;
  return bareName.startsWith(config.packageScope) ? bareName : `${config.packageScope}${bareName}`;
}

export function isGuardedBranch(config: MonocarveConfig, branch: string): boolean {
  return config.guardedBranches.includes(branch);
}

/** Every root whose contents the graph treats as first-party, longest first. */
export function firstPartyRoots(config: MonocarveConfig): string[] {
  return [
    ...config.applications.map((app) => withSlash(app.sourceRoot)),
    ...config.packageRoots.map(withSlash),
    ...config.firstPartyRoots.map(withSlash),
  ].sort((left, right) => right.length - left.length);
}

/** Roots a file may be moved OUT of: applications and existing packages. */
export function movableRoots(config: MonocarveConfig): string[] {
  return [
    ...config.applications.map((app) => withSlash(app.sourceRoot)),
    ...config.packageRoots.map(withSlash),
  ].sort((left, right) => right.length - left.length);
}

function withSlash(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}

/** Application owning a path, or null when it lives outside every `sourceRoot`. */
export function applicationFor(config: MonocarveConfig, path: string): ApplicationConfig | null {
  let match: ApplicationConfig | null = null;
  for (const app of config.applications) {
    const prefix = withSlash(app.sourceRoot);
    if (!path.startsWith(prefix)) continue;
    if (match === null || prefix.length > withSlash(match.sourceRoot).length) match = app;
  }
  return match;
}

/**
 * Owner of a path: the application it belongs to, or the package directory
 * directly under a configured package root, or its top-level directory.
 */
export function ownerFor(config: MonocarveConfig, path: string): string {
  const app = applicationFor(config, path);
  if (app) return applicationOwner(app);
  for (const root of config.packageRoots) {
    const prefix = withSlash(root);
    if (!path.startsWith(prefix)) continue;
    const name = path.slice(prefix.length).split("/")[0];
    if (name) return `${prefix}${name}`;
  }
  return path.split("/")[0] ?? "unknown";
}

/**
 * Directory that owns an application: the application root, one level above its
 * `sourceRoot` when the source root is nested (`apps/web/src` -> `apps/web`).
 */
export function applicationOwner(app: ApplicationConfig): string {
  const parts = app.sourceRoot.split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join("/") : app.sourceRoot;
}

/** True when the owner string names a configured application. */
export function isApplicationOwner(config: MonocarveConfig, owner: string): boolean {
  return config.applications.some((app) => applicationOwner(app) === owner);
}

/** True when the owner string is a directory under a configured package root. */
export function isPackageOwner(config: MonocarveConfig, owner: string): boolean {
  return config.packageRoots.some((root) => owner.startsWith(withSlash(root)));
}

/**
 * Runtime domain of a path: a configured domain whose pattern matches, else one
 * derived from the first directory segment below the owning application's
 * source root (with `nestedDomainRoots` taken one level deeper). Files directly
 * in the source root share the `__root__` domain.
 */
export function domainFor(config: MonocarveConfig, path: string): string {
  for (const domain of config.portfolio.domains) {
    if (domain.patterns.some((pattern) => new RegExp(pattern).test(path))) return domain.name;
  }
  const app = applicationFor(config, path);
  if (!app) return ownerFor(config, path);
  const parts = path.slice(withSlash(app.sourceRoot).length).split("/");
  const first = parts[0] ?? "__root__";
  if (parts.length === 1) return `${app.name}:__root__`;
  const nested = config.portfolio.nestedDomainRoots.includes(first);
  if (nested && parts[1] !== undefined && parts.length > 2) return `${app.name}:${first}/${parts[1]}`;
  return `${app.name}:${first}`;
}

/** Package name of a bare specifier: `@scope/name/sub` -> `@scope/name`. */
export function packageNameOf(specifier: string): string {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0] ?? specifier;
}

/** Compiled matcher for names a generated package may take. */
export function packageNameMatcher(config: MonocarveConfig): RegExp {
  if (config.packageNamePattern) return new RegExp(config.packageNamePattern);
  const scope = config.packageScope.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${scope}[a-z0-9][a-z0-9.-]*$`);
}
