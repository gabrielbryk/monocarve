/**
 * Rollback: exact restore, or loud residue.
 *
 * `applyPlan` replays a journal in the real checkout and then makes two commits.
 * Everything else in this tool detects problems; this is what runs when
 * detection fires, and the invariant it carries is the one the whole tool rests
 * on — "no partial application. A journal either applies completely or restores
 * every path it touched."
 *
 * The suite is a property test over *failure position*. For a plan of N
 * operations there are N + 3 places an apply can die:
 *
 *   - inside the journal, before operation `i`, for every `i` in `0..N-1`;
 *   - after the journal but before the move commit (regeneration, and the move
 *     commit's own R100 gate);
 *   - after the move commit but before the wiring commit (the wiring scope
 *     gate);
 *   - inside the wiring commit's own `git commit`.
 *
 * Each case asserts the same thing: the repository is byte-for-byte what it was
 * before, by hash and not by existence — every file's content, every directory,
 * the index verbatim, HEAD, and `git status`. `expectRestored` is that
 * assertion. Three mutations were run against it to show it can fail: skipping
 * `rollback`'s `restoreSnapshot` (five cases fail — the four boundary ones, on
 * a half-applied tree, and the residue case, which stops having residue to
 * report), resetting to `HEAD` instead of to the pre-apply commit (the two
 * post-move-commit cases fail, on the commit left standing), and restoring
 * empty bytes instead of the snapshot's (fifteen cases fail, which is what
 * "hashes, not existence" buys).
 *
 * What the sweep is a test *of* is worth stating: `executeJournal` restores its
 * own snapshot before rethrowing, so for a failure inside the journal the files
 * are already back before `rollback` runs, and `rollback` supplies the index and
 * HEAD reset. Disabling either one alone leaves this suite green; the cases are
 * about the recovery as a whole, which is what the invariant is about.
 *
 * ## On injection
 *
 * A rollback test is only worth its assertions if the failure it recovers from
 * is the kind of failure that actually happens. Four mechanisms are used here,
 * in descending order of preference:
 *
 *  1. **A genuine operating-system failure.** A directory the plan must write
 *     into is made read-only, so `mkdirSync`/`writeFileSync` fail with `EACCES`
 *     from the kernel. Nothing in `src/` knows this is a test. Better still,
 *     the simulation cannot see it: the mode change is on an *empty, untracked*
 *     directory, which git does not track and the simulation worktree therefore
 *     does not have — so the simulation passes and the real apply fails, which
 *     is exactly the situation rollback exists for.
 *  2. **A genuine refusal, by git or by the engine.** A `git commit` that dies
 *     in `gpg`, a wiring path the journal legitimately skipped, an index the
 *     plan does not account for. Nothing is stubbed and no error is fabricated.
 *  3. **A generator that leaves its output read-only**, which is what makes a
 *     *recovery* fail rather than an apply: the regeneration step runs a
 *     configured shell command between the journal and the move commit, and a
 *     generator that marks its artifact unwritable and then exits non-zero
 *     leaves the rollback a path it genuinely cannot put back. This is the only
 *     way this suite can produce residue at all any more, and that is itself a
 *     property of the fix: a restore now touches only what changed, so a file
 *     the transaction did not write can no longer refuse it, and a file the
 *     transaction *did* write was writable when it was written. Something has
 *     to change the permissions mid-flight, and only a generator can.
 *  4. **`MONOCARVE_FAIL_OPERATION`**, the injection seam that already exists in
 *     `executeJournal` (it predates this suite; see the commit that ported the
 *     transaction engine). It is used only for the interior journal positions,
 *     which mechanism 1 cannot reach — every interior operation writes into a
 *     directory an *earlier* operation had to create, so a read-only directory
 *     there fails the earlier operation instead.
 *
 * The seam is pinned to mechanism 1 by `seam and EACCES stop the journal at the
 * same operation`, and by the sweep's per-position count of the paths the
 * restore had to put back: a seam that fired anywhere other than where it says
 * would report a different count from the kernel refusal at the same position,
 * and the counts across the sweep are strictly increasing, so no two positions
 * are confusable. That comparison used to be made by freezing the half-applied
 * tree — an untouched read-only file made `restoreSnapshot` throw on its first
 * entry, before it had undone anything. That is precisely the defect the
 * recovery path was fixed for, so the freeze is gone by construction.
 *
 * No production-only seam was added for this suite.
 */

import { expect } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { pnpmAdapter } from "../../src/adapters/pnpm.ts";
import { CONFIG_BASENAME } from "../../src/branding.ts";
import { rewriteResolvedImportSpecifier } from "../../src/codemod/imports.ts";
import type { MonocarveConfig } from "../../src/config.ts";
import type { ExtractionManifest, PlanOperation } from "../../src/plan/manifest.ts";
import { assertPlanValid } from "../../src/plan/validate.ts";
import { fileState } from "../../src/util/files.ts";
import { hashText } from "../../src/util/hash.ts";
import { fixtureConfig, fixtureGit, fixtureRepo, read, write } from "./fixture-repo.ts";

export { cleanupFixtures, fixtureConfig, fixtureGit, fixtureRepo, read, write } from "./fixture-repo.ts";

export const DONOR = "apps/api/src/widget/widget.ts";
export const TARGET = "libs/analytics/src/widget/widget.ts";
const CONSUMER = "apps/api/src/consumer.ts";
export const ENTRYPOINT = "libs/analytics/src/index.ts";
/** Last operation's target, and the only one whose parent directory no earlier operation creates. */
export const TOKENS = "libs/analytics/generated/tokens.ts";
export const TOKENS_DIR = "libs/analytics/generated";
const PACKAGE = "@acme/analytics";
export const PACKAGE_ROOT = "libs/analytics";

const DONOR_TEXT = "export const widgetValue = 1;\n";
const CONSUMER_TEXT = 'import { widgetValue } from "./widget/widget.ts";\n\nexport const used = widgetValue + 1;\n';
export const BARREL = 'export * from "./widget/widget.ts";\n';
const TOKENS_TEXT = "export const tokens = 1;\n";

const LOCKFILE = ["lockfileVersion: '9.0'", "", "importers:", "", "  .: {}", "", "  libs/zeta: {}", ""].join("\n");
const IMPORTER_BLOCK = pnpmAdapter.importerBlock(LOCKFILE.replace("  libs/zeta: {}", "  libs/analytics: {}\n\n  libs/zeta: {}"), PACKAGE_ROOT)!;
export const LOCKFILE_APPLIED = pnpmAdapter.insertImporter(LOCKFILE, PACKAGE_ROOT, IMPORTER_BLOCK);

function packageManifest(name: string): string {
  return `${JSON.stringify(
    {
      name,
      version: "0.1.0",
      private: true,
      type: "module",
      main: "./src/index.ts",
      types: "./src/index.ts",
      exports: { ".": { types: "./src/index.ts", import: "./src/index.ts", default: "./src/index.ts" } },
    },
    null,
    2,
  )}\n`;
}

export function extractionFiles(): Record<string, string> {
  return {
    "package.json": `${JSON.stringify({ name: "fixture-workspace", private: true, type: "module" }, null, 2)}\n`,
    "pnpm-lock.yaml": LOCKFILE,
    "apps/api/tsconfig.json": `${JSON.stringify({ include: ["src"] }, null, 2)}\n`,
    [DONOR]: DONOR_TEXT,
    [CONSUMER]: CONSUMER_TEXT,
    [`${PACKAGE_ROOT}/package.json`]: packageManifest(PACKAGE),
  };
}

/**
 * Five operations, one of every kind the journal knows, ordered so that the
 * last one writes into a directory of its own. That last property is what makes
 * a genuine `EACCES` injection possible at the deepest journal position: every
 * other operation's parent directory is either the repository root or something
 * an earlier operation must be free to create.
 */
export function baseManifest(root: string): ExtractionManifest {
  const donorHash = hashText(read(root, DONOR));
  const consumerText = read(root, CONSUMER);
  const rewritten = rewriteResolvedImportSpecifier(consumerText, join(root, CONSUMER), join(root, DONOR), PACKAGE, root);

  const operations: PlanOperation[] = [
    { kind: "move", source: DONOR, target: TARGET, preconditionHash: donorHash, resultHash: donorHash },
    {
      kind: "rewrite-import",
      file: CONSUMER,
      donors: [DONOR],
      rewrites: [{ from: "./widget/widget.ts", to: PACKAGE }],
      preconditionHash: hashText(consumerText),
      resultHash: hashText(rewritten),
    },
    { kind: "write-file", path: ENTRYPOINT, contents: BARREL, preconditionHash: "missing", resultHash: hashText(BARREL), generator: "scaffold:entrypoint" },
    {
      kind: "lockfile-importer",
      lockfile: "pnpm-lock.yaml",
      packageRoot: PACKAGE_ROOT,
      block: IMPORTER_BLOCK,
      mode: "insert",
      preconditionHash: hashText(LOCKFILE),
      resultHash: hashText(LOCKFILE_APPLIED),
    },
    { kind: "write-file", path: TOKENS, contents: TOKENS_TEXT, preconditionHash: "missing", resultHash: hashText(TOKENS_TEXT), generator: "scaffold:tokens" },
  ];

  return {
    schemaVersion: 2,
    planId: "fixture-rollback",
    createdAt: new Date().toISOString(),
    generator: { name: "monocarve", version: "0.0.0" },
    baselineCommit: fixtureGit(root, "rev-parse", "HEAD"),
    graphDigest: hashText("fixture-graph"),
    application: "api",
    target: { packageName: PACKAGE, packageRoot: PACKAGE_ROOT, entrypoint: "src/index.ts", requiredExports: [{ name: "widgetValue", typeOnly: false }] },
    source: { files: [DONOR], tests: [], sccs: { "scc-fixture": [DONOR] } },
    dependencies: { runtime: {}, dev: {}, packageReferences: [] },
    sourceBlobs: { [DONOR]: donorHash },
    operations,
    consumers: [
      {
        file: CONSUMER,
        owner: "apps/api",
        expectedImporter: "./widget/widget.ts",
        specifiers: [{ from: "./widget/widget.ts", to: PACKAGE }],
        external: false,
        dependencySection: "runtime",
      },
    ],
    generatedFiles: [],
    changedFiles: [DONOR, TARGET, CONSUMER, ENTRYPOINT, TOKENS, "pnpm-lock.yaml"].toSorted(),
    lockfileImporter: { packageRoot: PACKAGE_ROOT, hash: hashText(IMPORTER_BLOCK) },
    expectedDynamicImportDelta: { added: [], removed: [] },
    evaluationEffects: [],
    metrics: { movedFiles: 1, movedLines: 1, applicationLinesBefore: 4, applicationLinesAfter: 3, consumers: 1 },
    commits: {
      plan: { subject: `chore(${PACKAGE}): compile extraction plan fixture-rollback` },
      move: { subject: `refactor(${PACKAGE}): move 1 files into ${PACKAGE_ROOT}`, body: "Extraction-Proof: simulated fixture-rollback" },
      wiring: { subject: `refactor(${PACKAGE}): wire ${PACKAGE} into the workspace` },
    },
    gates: { package: [], project: [], workspace: ["true"] },
  };
}

export const MANIFEST_PATH = "plans/fixture-rollback.json";

/**
 * Files whose bytes are a property of *which* fixture repository this is rather
 * than of what an apply did: the manifest carries the baseline commit, and the
 * config carries a per-test scratch worktree path. Comparing two independent
 * repositories has to leave them out; comparing one repository against itself
 * does not, and does not.
 */
const PER_FIXTURE_FILES = new Set([MANIFEST_PATH, `${CONFIG_BASENAME}.json`]);

function landManifest(root: string, manifest: ExtractionManifest): string {
  const path = MANIFEST_PATH;
  write(root, path, `${JSON.stringify(manifest, null, 2)}\n`);
  fixtureGit(root, "add", "--", path);
  fixtureGit(root, "commit", "-qm", manifest.commits.plan!.subject);
  return path;
}

export interface Fixture {
  readonly root: string;
  readonly config: MonocarveConfig;
  readonly manifest: ExtractionManifest;
  readonly manifestPath: string;
}

export function fixture(
  files: Record<string, string> = extractionFiles(),
  shape: (manifest: ExtractionManifest) => ExtractionManifest = (manifest) => manifest,
  configOverrides: Parameters<typeof fixtureConfig>[1] = {},
): Fixture {
  const root = fixtureRepo(files);
  const config = fixtureConfig(root, configOverrides);
  const manifest = shape(baseManifest(root));
  // A plan the validator rejects would fail `applyPlan` before the journal ever
  // ran, and every case below would then be asserting on a rollback that never
  // happened.
  expect(() => assertPlanValid(manifest, { config, rootDir: root })).not.toThrow();
  return { root, config, manifest, manifestPath: landManifest(root, manifest) };
}

// --- what "exactly as it was" means ------------------------------------------

export interface RepoState {
  /** Every file in the worktree except `.git`, path -> content hash. */
  readonly files: Record<string, string>;
  /** Every directory in the worktree except `.git`. */
  readonly directories: readonly string[];
  readonly head: string;
  /** The index verbatim: mode, blob, stage, path — one line per entry. */
  readonly index: string;
  /** Tracked and untracked, so a leftover file cannot hide in either. */
  readonly status: string;
  /** Staged content, which must be empty at rest and after a rollback. */
  readonly staged: string;
}

function walk(root: string, prefix = ""): { files: Record<string, string>; directories: string[] } {
  const files: Record<string, string> = {};
  const directories: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (relative === ".git") continue;
    if (entry.isDirectory()) {
      directories.push(relative);
      const nested = walk(root, relative);
      Object.assign(files, nested.files);
      directories.push(...nested.directories);
      continue;
    }
    files[relative] = fileState(join(root, relative));
  }
  return { files, directories };
}

/** {@link walk}'s files without the two paths that differ between fixtures. */
export function comparableFiles(root: string): Record<string, string> {
  return Object.fromEntries(Object.entries(walk(root).files).filter(([path]) => !PER_FIXTURE_FILES.has(path)));
}

export function repoState(root: string): RepoState {
  const { files, directories } = walk(root);
  return {
    files,
    directories,
    head: fixtureGit(root, "rev-parse", "HEAD"),
    index: fixtureGit(root, "ls-files", "--stage"),
    status: fixtureGit(root, "status", "--porcelain=v1", "--untracked-files=all"),
    staged: fixtureGit(root, "diff", "--cached", "--name-status"),
  };
}

/**
 * The central assertion. Every field is compared, and each can fail on its own
 * kind of bug: `files` on content that was restored to the wrong bytes or not at
 * all, `directories` on a tree the extraction created and the undo left behind,
 * `head` on a commit left standing, `index` on a staged rename that was never
 * unstaged — or on staging the transaction never owned and unstaged anyway —
 * and `status`/`staged` on anything the others could miss.
 *
 * Directories are compared here, and were not when this suite was written: the
 * snapshot is keyed by file path, `rmSync` leaves parents behind, and git tracks
 * no empty directory, so an undone extraction used to leave its skeleton in the
 * checkout with nothing loud about it. `leaves no directory the journal created`
 * pins both halves of the fix — what is pruned and what deliberately is not.
 */
export function expectRestored(after: RepoState, before: RepoState): void {
  expect(after.files).toEqual(before.files);
  expect(after.directories).toEqual(before.directories);
  expect(after.head).toBe(before.head);
  expect(after.index).toBe(before.index);
  expect(after.status).toBe(before.status);
  expect(after.staged).toBe(before.staged);
}

/** Fails the run rather than the assertion when a case stops failing at all. */
export async function expectApplyToFail(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("apply was expected to fail and did not");
}

/**
 * Runs `body` with `directory` read-only, then puts the directory back the way
 * the baseline had it — which is to say gone, since git cannot track an empty
 * one and the fixture therefore never had it.
 *
 * The emptiness check is not tidiness. Removing the directory is the one thing
 * this helper does that could *hide* residue: a rollback that left files under
 * it would be swept away before the caller ever compared states. So the removal
 * asserts first, and only ever deletes nothing.
 */
export async function withReadOnlyDirectory(absolute: string, body: () => Promise<void>): Promise<void> {
  mkdirSync(absolute, { recursive: true });
  chmodSync(absolute, 0o555);
  try {
    await body();
  } finally {
    chmodSync(absolute, 0o755);
    expect(readdirSync(absolute)).toEqual([]);
    rmSync(absolute, { recursive: true, force: true });
  }
}

/**
 * How many of the plan's six paths differ from the baseline when the journal
 * dies before operation `i`, and therefore how many the journal's own restore
 * has to put back: nothing before operation 0; the donor and its target after
 * the move; then the rewritten consumer, the scaffolded entrypoint, and the
 * lockfile, one per operation.
 *
 * The sequence is strictly increasing, which is what makes it evidence rather
 * than arithmetic: a journal that stopped at a different operation than the one
 * it names would report a count belonging to some other position, and a restore
 * that had started rewriting untouched paths again would report a count larger
 * than any position can produce.
 */
export const RESTORED_BEFORE_OPERATION = [0, 2, 3, 4, 5];
const JOURNAL_PATHS = 6;

/** What the journal says when it put `count` paths back; it says nothing at zero. */
export function restoreNote(count: number): string {
  return `journal restored ${count} of ${JOURNAL_PATHS} path(s) to their pre-journal state`;
}
