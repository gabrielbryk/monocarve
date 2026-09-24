import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

import { loadSnapshotConfig, type ConfigSnapshotFile } from "../assessment/config-snapshot.ts";
import { CONFIG_FILENAMES } from "../branding.ts";
import { ConfigError } from "../errors.ts";
import { monocarveConfigSchema, type MonocarveConfig } from "./schema.ts";

export interface LoadedConfig {
  /** Validated config with all defaults applied. */
  readonly config: MonocarveConfig;
  /** Absolute path of the config file that was loaded. */
  readonly configPath: string;
  /** Absolute repo root (`dirname(configPath)` joined with `config.root`). */
  readonly rootDir: string;
  /** Exact pre-config bytes exposed to an isolated executable config. */
  readonly configSnapshot?: readonly ConfigSnapshotFile[];
}

export interface LoadConfigOptions {
  /** Explicit config path; skips discovery. */
  readonly configPath?: string;
  /** Directory discovery starts from. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Refuse config dependency closures that can read files outside inventory capture. */
  readonly refuseStaticFilesystemImports?: boolean;
  readonly executionBoundary?: "snapshot";
}

/** Walk up from `startDir` looking for a config file. Returns null if none. */
export function findConfigFile(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    for (const filename of CONFIG_FILENAMES) {
      const candidate = join(dir, filename);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const configPath = options.configPath ? resolve(cwd, options.configPath) : findConfigFile(cwd);

  if (!configPath) {
    throw new ConfigError(`no config found in ${cwd} or any parent directory (looked for ${CONFIG_FILENAMES.join(", ")})`);
  }
  if (!existsSync(configPath)) {
    throw new ConfigError(`config not found: ${configPath}`);
  }

  if (options.refuseStaticFilesystemImports) assertNoStaticFilesystemImports(configPath);

  const snapshot = options.executionBoundary === "snapshot" && !configPath.endsWith(".json") ? loadSnapshotConfig(configPath) : undefined;
  const raw = snapshot === undefined ? await readRawConfig(configPath) : snapshot.value;
  const config = parseConfig(raw, configPath);
  return { config, configPath, rootDir: resolve(dirname(configPath), config.root), ...(snapshot === undefined ? {} : { configSnapshot: snapshot.files }) };
}

/**
 * Refuse statically visible filesystem imports before assessment config execution.
 * This is a partial guard: indirect runtime reads such as Bun.file remain unbound.
 * Ordinary config loading does not enable this policy.
 */
export function assertNoStaticFilesystemImports(configPath: string): void {
  const seen = new Set<string>();
  const pending = [resolve(configPath)];
  while (pending.length > 0) {
    const path = pending.pop()!;
    const absolute = resolve(path);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    pending.push(...configDependencies(absolute));
  }
}

function configDependencies(path: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(`config dependency cannot be inspected: ${path}`);
  }
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const nodes: ts.Node[] = [source];
  const dependencies: string[] = [];
  while (nodes.length > 0) {
    const node = nodes.pop()!;
    const specifier = configSpecifier(node, source, path);
    if (specifier !== undefined) {
      const dependency = resolveConfigDependency(specifier, path);
      if (dependency !== undefined) dependencies.push(dependency);
    }
    nodes.push(...node.getChildren(source));
  }
  return dependencies;
}

function configSpecifier(node: ts.Node, source: ts.SourceFile, path: string): string | undefined {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
    return node.moduleSpecifier.text;
  if (!ts.isCallExpression(node)) return undefined;
  const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
  const required = node.expression.getText(source) === "require";
  if (!dynamic && !required) return undefined;
  const argument = node.arguments[0];
  if (!argument || !ts.isStringLiteral(argument)) throw new ConfigError(`ASSESSMENT_CONFIG_UNBOUND: dynamic config dependency in ${path}`);
  return argument.text;
}

function resolveConfigDependency(specifier: string, path: string): string | undefined {
  if (isFilesystemModule(specifier)) throw new ConfigError(`ASSESSMENT_CONFIG_UNBOUND: filesystem access in config dependency ${path}`);
  if (specifier.startsWith("node:")) return undefined;
  try {
    return Bun.resolveSync(specifier, dirname(path));
  } catch {
    throw new ConfigError(`config dependency cannot be resolved: ${specifier}`);
  }
}

function isFilesystemModule(specifier: string): boolean {
  return specifier === "fs" || specifier === "node:fs" || specifier === "fs/promises" || specifier === "node:fs/promises";
}

/** Validate an already-loaded object. Exposed for tests and programmatic use. */
export function parseConfig(raw: unknown, source = "<inline>"): MonocarveConfig {
  const result = monocarveConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  ${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`);
    throw new ConfigError(`invalid config at ${source}:\n${issues.join("\n")}`);
  }
  return result.data;
}

async function readRawConfig(configPath: string): Promise<unknown> {
  if (configPath.endsWith(".json")) {
    const text = await readFile(configPath, "utf8");
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new ConfigError(`could not parse ${configPath}: ${(error as Error).message}`);
    }
  }

  // TS/ESM configs are imported. Under Bun this works directly; under plain
  // Node a `.ts` config needs a loader, which is why `.json` stays supported.
  const module = (await import(pathToFileURL(configPath).href)) as { default?: unknown };
  if (module.default === undefined) {
    throw new ConfigError(`${configPath} has no default export`);
  }
  return module.default;
}

/* -------------------------------------------------------------------------- */
/* Derived helpers                                                            */
/* -------------------------------------------------------------------------- */
