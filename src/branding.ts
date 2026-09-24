/**
 * Every occurrence of the tool's own name lives here.
 *
 * Renaming the project should be a one-file edit plus `package.json`/docs — no
 * module elsewhere may hardcode the string "monocarve". If you need the name,
 * import it from here.
 */

export const TOOL_NAME = "monocarve" as const;
export const SIMULATION_GIT_IDENTITY = { name: TOOL_NAME, email: `${TOOL_NAME}@invalid` } as const;
export const FAIL_OPERATION_ENV = "MONOCARVE_FAIL_OPERATION" as const;

/** Overrides where disposable worktrees and scratch directories are created. */
export const SCRATCH_ROOT_ENV = "MONOCARVE_SCRATCH_ROOT" as const;

/**
 * Kept in sync with `package.json#version` by hand; the release workflow
 * (`.github/workflows/release.yml`) refuses to publish a tag where this and
 * `package.json#version` disagree with each other or with the tag itself.
 */
export const TOOL_VERSION = "0.1.0" as const;

/** Basename (without extension) of the project config file. */
export const CONFIG_BASENAME = `${TOOL_NAME}.config` as const;

/**
 * Config filenames probed during upward discovery, in precedence order.
 * `.ts` first: the config is code, and the typed `defineConfig` helper is the
 * intended authoring path.
 */
export const CONFIG_FILENAMES = [
  `${CONFIG_BASENAME}.ts`,
  `${CONFIG_BASENAME}.mts`,
  `${CONFIG_BASENAME}.js`,
  `${CONFIG_BASENAME}.mjs`,
  `${CONFIG_BASENAME}.json`,
] as const;

/** Directory (repo-relative) for tool scratch state: worktrees, simulation roots. */
export const SCRATCH_DIRNAME = `.${TOOL_NAME}` as const;

/** Prefix for disposable path-migration command directories. */
export const PATH_MIGRATION_TMP_PREFIX = `${TOOL_NAME}-path-migration-` as const;

/** Git-common-dir operational state for one committing extraction transaction. */
export const APPLY_LOCK_FILENAME = `${TOOL_NAME}-apply.lock` as const;
export const APPLY_STATE_FILENAME = `${TOOL_NAME}-apply-state.json` as const;

/** Generator stamp embedded in every plan manifest for provenance. */
export const GENERATOR = { name: TOOL_NAME, version: TOOL_VERSION } as const;
