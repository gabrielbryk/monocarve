import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
}

export interface LoadConfigOptions {
  /** Explicit config path; skips discovery. */
  readonly configPath?: string;
  /** Directory discovery starts from. Defaults to `process.cwd()`. */
  readonly cwd?: string;
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
    throw new ConfigError(
      `no config found in ${cwd} or any parent directory (looked for ${CONFIG_FILENAMES.join(", ")})`,
    );
  }
  if (!existsSync(configPath)) {
    throw new ConfigError(`config not found: ${configPath}`);
  }

  const raw = await readRawConfig(configPath);
  const config = parseConfig(raw, configPath);
  return { config, configPath, rootDir: resolve(dirname(configPath), config.root) };
}

/** Validate an already-loaded object. Exposed for tests and programmatic use. */
export function parseConfig(raw: unknown, source = "<inline>"): MonocarveConfig {
  const result = monocarveConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `  ${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`,
    );
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
