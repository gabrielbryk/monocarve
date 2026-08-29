/**
 * Adapter interfaces.
 *
 * Everything workspace-tool-specific lives behind these two interfaces. The
 * engine may never branch on `config.packageManager` or `config.taskRunner`
 * outside `registry.ts` — if a stage needs different behaviour per tool, that
 * behaviour becomes a method here.
 *
 * The lockfile methods are pure text transformations on purpose. A plan
 * declares the hash the lockfile must have *after* it is edited, which is only
 * meaningful if the edit is a deterministic function of (text, block) that the
 * simulation, the apply, and the audit can each compute independently.
 */

import type { LockfileImporterMode } from "../plan/manifest.ts";
import type { Sha256 } from "../util/hash.ts";

/** The package.json section that owns a consumer's package reference. */
export type ConsumerDependencySection = "runtime" | "dev";

export interface WorkspacePackage {
  /** Declared package name, e.g. `@acme/logger`. */
  readonly name: string;
  /** Workspace-relative directory. */
  readonly dir: string;
  readonly private?: boolean;
}

export interface RenderImporterInput {
  /** Directory the block describes, workspace-relative. */
  readonly packageRoot: string;
  /**
   * Declared name of the package at `packageRoot`, when the caller has read it.
   *
   * Optional because a lockfile keyed purely by directory has no use for it —
   * pnpm's importers are one such. A lockfile that also records the package's
   * identity (bun writes `name` and `version` into its `workspaces` entry, and
   * keys the workspace link by the name) cannot render a block without it, and
   * refuses rather than inventing one.
   */
  readonly packageName?: string;
  /** Declared version of the package at `packageRoot`, when it has one. */
  readonly packageVersion?: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  /**
   * Optional dependencies, absent when the package declares none. A rendered
   * block carries the section only if it is passed one: omitting the field is
   * how a caller says "no optional dependencies", and a caller that has some and
   * does not pass them gets a block missing a section its manifest declares.
   */
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  /**
   * Current lockfile text; versions are resolved against it, never invented.
   *
   * "Never invented" is the whole contract, and it is stronger than "not made
   * up": a version is only writable when this text either already resolves the
   * same specifier somewhere, or carries an entry for the exact version being
   * asked for. Anything else is a refusal, because an importer entry with no
   * resolution behind it is a lockfile that regenerates byte-identically and
   * still cannot be installed.
   */
  readonly lockfileText: string;
  /** Package name -> workspace directory, for resolving `workspace:*` links. */
  readonly workspaceRoots: Readonly<Record<string, string>>;
}

/**
 * The outcome of an adapter-owned edit.
 *
 * `already-satisfied` is deliberately distinct from `unmet-precondition`.
 * Both used to be represented by `null`, which let the planner mistake an
 * adapter that could not perform a required registration for one that had
 * verified no registration was needed.
 */
export type AdapterEditResult =
  | { readonly kind: "changed"; readonly contents: string }
  | { readonly kind: "already-satisfied" }
  | { readonly kind: "unmet-precondition"; readonly reason: string };

export interface PackageManagerAdapter {
  readonly id: string;
  /** Version of this adapter's deterministic planning/replay contract. */
  readonly contractVersion?: number;
  /** Version declaration carried by tracked root package.json bytes, if unambiguous. */
  declaredVersion?(rootPackageJson: string): string | undefined;

  /** Lockfile basename at the workspace root, e.g. `pnpm-lock.yaml`. */
  readonly lockfileName: string;

  /**
   * File declaring workspace membership — a file of the manager's own
   * (`pnpm-workspace.yaml`) or the root `package.json` when membership lives in
   * its `workspaces` array. `null` only for a manager with no membership
   * declaration at all, which makes registration a no-op the scaffolder skips.
   */
  readonly workspaceManifestName: string | null;

  /** Enumerate current workspace packages. Answers "is this already a package?". */
  listPackages(rootDir: string): Promise<WorkspacePackage[]>;

  /**
   * Render the lockfile importer block for a package. Pure over the dependency
   * lists so the plan can carry it as text.
   */
  renderImporterBlock(input: RenderImporterInput): string;

  /** The block currently present for `packageRoot`, or undefined when it has none. */
  importerBlock(lockfileText: string, packageRoot: string): string | undefined;

  /**
   * Whether a block held on its own really is the block for `packageRoot`.
   *
   * Plan validation asks this of the text a manifest carries, with no lockfile
   * around it to read the block back out of, so it cannot go through
   * `importerBlock`. It is a question about the lockfile's grammar and
   * therefore adapter-owned: the caller may not know that one manager keys an
   * importer by a bare directory and another by a JSON string, still less that
   * the workspace root is spelled `.` in one and `""` in the other.
   */
  blockDeclaresImporter(block: string, packageRoot: string): boolean;

  /**
   * Insert `block` at its deterministic (sorted) position. A no-op when the
   * package already has a block, so replaying a journal is idempotent.
   */
  insertImporter(lockfileText: string, packageRoot: string, block: string): string;

  /** Replace the existing block for `packageRoot`. Throws when there is none. */
  replaceImporter(lockfileText: string, packageRoot: string, block: string): string;

  /** Apply an importer operation according to its mode. */
  applyImporter(lockfileText: string, packageRoot: string, block: string, mode?: LockfileImporterMode): string;

  /**
   * Resolutions the importers name that the lockfile does not carry an entry
   * for, one human-readable line each, empty when there are none.
   *
   * This is the one lockfile question regenerating the file cannot answer. A
   * lockfile can be *incomplete* rather than mis-serialized — an importer
   * pointing at a version with no entry behind it — and a canonical
   * re-serialization preserves that exactly, so the regenerate-and-compare
   * check calls it agreement while a frozen install refuses it. It is a pure
   * text function on purpose: no network, no package-manager run, so the
   * verification can afford to ask it every time.
   */
  missingResolutions(lockfileText: string): readonly string[];

  /**
   * Hash of the importer block currently present for `packageRoot`. The audit
   * compares this to the hash of the block the plan declared.
   */
  lockfileImporterHash(lockfileText: string, packageRoot: string): Sha256 | undefined;

  /**
   * Add one dependency to an existing importer block, at its sorted position.
   * Used to wire a consuming application to the newly created package.
   * Returns the block unchanged when it already declares the dependency.
   */
  addBlockDependency(
    block: string,
    name: string,
    specifier: string,
    version: string,
    section?: ConsumerDependencySection,
  ): string;

  /**
   * Add the declared dependency sets to an existing importer, resolving exact
   * versions from the current lockfile. Existing unrelated entries are kept.
   */
  addBlockDependencies(block: string, input: RenderImporterInput): string;

  /** Remove one exact dependency from an existing importer block. */
  removeBlockDependency(block: string, name: string): string;

  /** Lockfile version string linking `fromRoot` to a workspace package at `toRoot`. */
  linkVersion(fromRoot: string, toRoot: string): string;

  /**
   * Outcome of adding the package to the workspace manifest. An adapter must
   * report an unmet precondition rather than silently declining a required
   * membership edit.
   */
  workspaceManifestEdit(manifestText: string, packageRoot: string): AdapterEditResult;

  /** Command that materializes `node_modules` in a fresh worktree. */
  installCommand(): readonly string[];

  /**
   * Command that rewrites the lockfile from the manifests and touches nothing
   * else — no `node_modules`, no downloads beyond resolution. It exists for the
   * opt-in verification, which is the only thing in the pipeline that asks the
   * package manager what the lockfile should look like instead of asking the
   * adapter's own splice.
   */
  lockfileOnlyCommand(): readonly string[];
}

export interface TaskRunnerAdapter {
  readonly id: string;
  /** Version of this adapter's deterministic planning/replay contract. */
  readonly contractVersion?: number;
  /** Version declaration carried by tracked root package.json bytes, if unambiguous. */
  declaredVersion?(rootPackageJson: string): string | undefined;

  /** Project file created for a new package, e.g. `moon.yml`. Null when none. */
  readonly projectFileName: string | null;

  /**
   * Workspace-level configuration file used to register a new project. Null
   * when the runner has no such registry or discovers projects implicitly.
   *
   * This is deliberately adapter-owned: the scaffolder only knows that a
   * runner may need registration, never a runner's configuration path or id.
   */
  readonly projectRegistryFileName: string | null;

  /** Project id the runner will address the new package by. */
  projectIdFor(packageName: string, packageRoot: string): string;

  /**
   * Project id an *existing* directory is addressed by, read from its project
   * file when it declares one. Gate commands for consuming applications are
   * rendered from this, so a project whose id differs from its directory name
   * still gets the right command.
   */
  projectIdOf(rootDir: string, packageRoot: string): string;

  /**
   * Outcome of registering the project in a workspace-level project list. An
   * adapter must report an unmet precondition rather than silently declining a
   * required registration.
   */
  registerProject(workspaceConfigText: string, packageRoot: string, projectId: string): AdapterEditResult;

  /**
   * Wrap a configured gate command for execution. Most runners just execute the
   * template verbatim; this seam exists for runners that require a prefix or a
   * `--` argument boundary.
   */
  wrapGateCommand(command: string): readonly string[];
}
