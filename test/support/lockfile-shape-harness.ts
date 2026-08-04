/**
 * Workspace shapes, and the harness that grades a splice against real pnpm.
 *
 * The lockfile splicer edits YAML as lines. Whether the lines it writes are the
 * ones the package manager would have written is therefore an empirical
 * question, and three hand-built examples answer it for three workspaces. This
 * file turns the examples into a parameter: a shape describes a workspace in the
 * terms that change what pnpm serializes — how many importers there are, which
 * of them have nothing to declare, how their directory names sort, which
 * dependency sections they carry — and `checkShape` runs the whole loop for one.
 *
 * The loop is: build the workspace without the new package, let pnpm write the
 * baseline lockfile, apply exactly the adapter calls `scaffold.ts` makes, then
 * let pnpm write the lockfile again from the same manifests and compare.
 *
 * Two things about the comparison are deliberate.
 *
 *  - It is a sha256 of the *bytes*, not the verdict of `lockfileDifference`.
 *    That helper is under test here as much as the splicer is; grading a splice
 *    with it would let a diff bug and a splice bug cancel out.
 *  - The baseline is generated, never checked in. A hand-written lockfile
 *    diverges from every real pnpm on its own, and the divergence under test
 *    would be lost in the noise.
 *
 * What a failure looks like: `checkShape` returns `diverged` with both byte
 * strings, and the shape's declared expectation says which of `matched`,
 * `diverged`, or `threw` was supposed to happen. The harness is not vacuous
 * because `SHAPES` includes cases that must diverge and cases that must throw —
 * if it reported `matched` unconditionally, those would fail.
 *
 * ## What this oracle can and cannot see
 *
 * `pnpm install --lockfile-only` is not a validator. Measured against pnpm
 * 11.17.0, it parses the lockfile, re-resolves what the manifests no longer
 * agree with, and writes the structure back in canonical form. So it *does*
 * catch everything that survives as a serialization difference — sort order,
 * quoting, `{}` versus a bare key, section order, a version that resolution
 * would have written differently — which is what makes the sorting and inline
 * shapes below mean something. `MIS_SORTED_SPLICE` proves that directly.
 *
 * What it does not catch is a lockfile that is *incomplete* in a way the
 * round-trip preserves. `ORACLE_BLIND_SPOT` is the case: an importer that names
 * an external dependency with no matching `packages:`/`snapshots:` entry
 * round-trips byte-for-byte, and only `--frozen-lockfile` calls it broken.
 * Anything relying on the round-trip alone inherits that blind spot, which is
 * why the adapter now refuses to write such an entry and
 * `pnpmAdapter.missingResolutions` reads one back out of a lockfile that has
 * one anyway. Both halves are graded here against the same pnpm.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { pnpmAdapter } from "../../src/adapters/pnpm.ts";
import { hashBytes, type Sha256 } from "../../src/util/hash.ts";
import { scratchDirectory, write } from "./fixture-repo.ts";

const LOCKFILE = pnpmAdapter.lockfileName;
const WORKSPACE_MANIFEST = pnpmAdapter.workspaceManifestName ?? "pnpm-workspace.yaml";

export interface PackageShape {
  /** Workspace-relative directory. `.` is the workspace root itself. */
  readonly root: string;
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  /**
   * Dependencies written into the package's manifest and never handed to the
   * renderer.
   *
   * One shape needs them: the adapter now refuses to write an importer entry
   * for a version the lockfile does not carry, so the only way to keep grading
   * the *oracle* on such a lockfile is to build those bytes by hand while the
   * manifest still declares the dependency — otherwise the next pnpm run would
   * simply delete the entry under test.
   */
  readonly unrenderedDependencies?: Readonly<Record<string, string>>;
}

export type ShapeExpectation = "match" | "diverge" | "throw";

export interface WorkspaceShape {
  readonly id: string;
  /** What this shape is for — quoted in the report, not just in the source. */
  readonly why: string;
  /** Packages that exist before the plan runs, in creation order. */
  readonly packages: readonly PackageShape[];
  /** The workspace root manifest's own dependencies, which make `.` a block. */
  readonly rootDependencies?: Readonly<Record<string, string>>;
  /** `catalog:` entries for `pnpm-workspace.yaml`. */
  readonly catalog?: Readonly<Record<string, string>>;
  /**
   * Membership globs. Defaulting to one entry per package root is what makes
   * `workspaceManifestEdit` run on most shapes; a shape that wants the
   * already-covered path says so with `["apps/*", "libs/*"]`.
   */
  readonly globs?: readonly string[];
  /** The package the plan creates. */
  readonly target: PackageShape;
  /** Roots that gain a dependency on the target. */
  readonly consumers: readonly string[];
  /** Deliberate corruption of the spliced bytes, for the harness's own proof. */
  readonly mutate?: (spliced: string) => string;
  readonly expect: ShapeExpectation;
  /**
   * Named lines the divergence must consist of. A shape that only asserted
   * "diverged" would keep passing if the divergence moved somewhere else
   * entirely, which is how a pinned bug stops describing the bug.
   */
  readonly plannedOnly?: readonly string[];
  readonly regeneratedOnly?: readonly string[];
  /** What the refusal must say, for `expect: "throw"`. */
  readonly throwMessage?: RegExp;
}

export type ShapeResult =
  | {
      readonly kind: "matched";
      /** The workspace, kept so a caller can ask the package manager something else. */
      readonly root: string;
      readonly baseline: string;
      readonly planned: string;
      readonly hash: Sha256;
    }
  | {
      readonly kind: "diverged";
      readonly root: string;
      readonly baseline: string;
      readonly planned: string;
      readonly regenerated: string;
      readonly plannedHash: Sha256;
      readonly regeneratedHash: Sha256;
    }
  | { readonly kind: "threw"; readonly root: string; readonly baseline: string; readonly error: Error };

function manifestJson(shape: PackageShape, extraDependencies: Readonly<Record<string, string>> = {}): string {
  const dependencies = { ...shape.dependencies, ...shape.unrenderedDependencies, ...extraDependencies };
  return `${JSON.stringify(
    {
      name: shape.name,
      version: "0.1.0",
      private: true,
      type: "module",
      main: "./src/index.ts",
      types: "./src/index.ts",
      ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
      ...(shape.devDependencies && Object.keys(shape.devDependencies).length > 0
        ? { devDependencies: shape.devDependencies }
        : {}),
      ...(shape.optionalDependencies && Object.keys(shape.optionalDependencies).length > 0
        ? { optionalDependencies: shape.optionalDependencies }
        : {}),
    },
    null,
    2,
  )}\n`;
}

function rootManifest(shape: WorkspaceShape, extraDependencies: Readonly<Record<string, string>> = {}): string {
  const dependencies = { ...shape.rootDependencies, ...extraDependencies };
  return `${JSON.stringify(
    {
      name: "fixture-workspace",
      private: true,
      type: "module",
      ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
    },
    null,
    2,
  )}\n`;
}

function workspaceManifest(shape: WorkspaceShape): string {
  const globs = shape.globs ?? shape.packages.map((pkg) => pkg.root);
  const catalog = shape.catalog ?? {};
  const catalogLines =
    Object.keys(catalog).length === 0
      ? []
      : ["catalog:", ...Object.entries(catalog).map(([name, range]) => `  ${name}: ${range}`)];
  return `${["packages:", ...globs.map((glob) => `  - ${glob}`), ...catalogLines].join("\n")}\n`;
}

/** Package name -> workspace directory, as `plan/context.ts` supplies it. */
function workspaceRoots(shape: WorkspaceShape): Record<string, string> {
  const roots: Record<string, string> = {};
  for (const pkg of [...shape.packages, shape.target]) roots[pkg.name] = pkg.root;
  return roots;
}

/** The workspace as it stands before the plan — every package except the target. */
function baselineFiles(shape: WorkspaceShape): Record<string, string> {
  const files: Record<string, string> = {
    "package.json": rootManifest(shape),
    [WORKSPACE_MANIFEST]: workspaceManifest(shape),
  };
  for (const pkg of shape.packages) files[`${pkg.root}/package.json`] = manifestJson(pkg);
  return files;
}

/**
 * Exactly the adapter calls `scaffold.ts` makes, in the order it makes them:
 * the new package's block inserted at its sorted position, then one
 * `addBlockDependency` + `replaceImporter` per consuming application.
 */
export function spliceLockfile(baseline: string, shape: WorkspaceShape): string {
  const block = `${pnpmAdapter.renderImporterBlock({
    packageRoot: shape.target.root,
    dependencies: shape.target.dependencies ?? {},
    devDependencies: shape.target.devDependencies ?? {},
    optionalDependencies: shape.target.optionalDependencies ?? {},
    lockfileText: baseline,
    workspaceRoots: workspaceRoots(shape),
  })}\n\n`;
  let text = pnpmAdapter.insertImporter(baseline, shape.target.root, block);
  for (const consumer of shape.consumers) {
    const existing = pnpmAdapter.importerBlock(text, consumer);
    // `scaffold.ts` refuses rather than skipping when the consumer has no
    // importer, so a harness that quietly produced an unwired lockfile would be
    // grading something the engine cannot emit.
    if (existing === undefined) throw new Error(`no importer block for the consumer ${consumer}`);
    text = pnpmAdapter.replaceImporter(
      text,
      consumer,
      pnpmAdapter.addBlockDependency(
        existing,
        shape.target.name,
        "workspace:*",
        pnpmAdapter.linkVersion(consumer, shape.target.root),
      ),
    );
  }
  return text;
}

export function runLockfileOnly(cwd: string): void {
  const [binary, ...args] = pnpmAdapter.lockfileOnlyCommand();
  const result = Bun.spawnSync([binary!, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if ((result.exitCode ?? 1) !== 0) {
    throw new Error(`${pnpmAdapter.lockfileOnlyCommand().join(" ")} failed in ${cwd}: ${result.stderr.toString()}`);
  }
}

/**
 * The other question the package manager can be asked: not "what would you
 * write?" but "can you install what is written?". `--lockfile-only` answers the
 * first and is the flag the engine uses; this answers the second, and the two
 * disagree in exactly one place, which is why it exists here.
 */
export function frozenLockfileFailure(cwd: string): string | undefined {
  const [binary, ...args] = pnpmAdapter.installCommand();
  const result = Bun.spawnSync([binary!, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return (result.exitCode ?? 1) === 0 ? undefined : `${result.stdout.toString()}${result.stderr.toString()}`;
}

/** Build, splice, regenerate, compare. The one function every shape runs. */
export function checkShape(shape: WorkspaceShape): ShapeResult {
  const root = scratchDirectory();
  for (const [path, contents] of Object.entries(baselineFiles(shape))) write(root, path, contents);
  runLockfileOnly(root);
  const lockfile = join(root, LOCKFILE);
  const baseline = readFileSync(lockfile, "utf8");

  let spliced: string;
  try {
    spliced = spliceLockfile(baseline, shape);
  } catch (error) {
    return { kind: "threw", root, baseline, error: error as Error };
  }

  // The manifest edits that accompany the splice. Without them the second pnpm
  // run would be resolving a different workspace, and any agreement it reported
  // would be about a plan nobody wrote.
  write(root, `${shape.target.root}/package.json`, manifestJson(shape.target));
  for (const consumer of shape.consumers) {
    if (consumer === ".") {
      write(root, "package.json", rootManifest(shape, { [shape.target.name]: "workspace:*" }));
      continue;
    }
    const pkg = shape.packages.find((candidate) => candidate.root === consumer);
    if (!pkg) throw new Error(`shape ${shape.id} names a consumer it never creates: ${consumer}`);
    write(root, `${consumer}/package.json`, manifestJson(pkg, { [shape.target.name]: "workspace:*" }));
  }
  const membership = pnpmAdapter.workspaceManifestEdit(workspaceManifest(shape), shape.target.root);
  if (membership.kind === "changed") write(root, WORKSPACE_MANIFEST, membership.contents);
  if (membership.kind === "unmet-precondition") {
    throw new Error(`shape ${shape.id} cannot register ${shape.target.root}: ${membership.reason}`);
  }

  writeFileSync(lockfile, shape.mutate ? shape.mutate(spliced) : spliced);
  const plannedBytes = readFileSync(lockfile);
  const plannedHash = hashBytes(plannedBytes);

  runLockfileOnly(root);
  const regeneratedBytes = readFileSync(lockfile);
  const regeneratedHash = hashBytes(regeneratedBytes);

  return plannedHash === regeneratedHash
    ? { kind: "matched", root, baseline, planned: plannedBytes.toString(), hash: plannedHash }
    : {
        kind: "diverged",
        root,
        baseline,
        planned: plannedBytes.toString(),
        regenerated: regeneratedBytes.toString(),
        plannedHash,
        regeneratedHash,
      };
}

/**
 * The differing region, found without `lockfileDifference`.
 *
 * Reusing the production helper to explain a failure would be convenient and
 * wrong: the same trimming bug that hid a divergence would then also shape the
 * report of it. This is a deliberately dumb first/last differing line scan.
 */
export function describeResult(shape: WorkspaceShape, result: ShapeResult): string {
  if (result.kind === "threw") return `${shape.id}: threw ${result.error.name}: ${result.error.message}`;
  if (result.kind === "matched") return `${shape.id}: matched (sha256 ${result.hash})`;

  const left = result.planned.split("\n");
  const right = result.regenerated.split("\n");
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let tail = 0;
  while (
    tail < left.length - start &&
    tail < right.length - start &&
    left[left.length - 1 - tail] === right[right.length - 1 - tail]
  ) {
    tail += 1;
  }
  const plannedMiddle = left.slice(start, left.length - tail);
  const regeneratedMiddle = right.slice(start, right.length - tail);
  return [
    `${shape.id}: diverged at line ${start + 1}`,
    `  planned     sha256 ${result.plannedHash}`,
    `  regenerated sha256 ${result.regeneratedHash}`,
    "  --- spliced ---",
    ...plannedMiddle.map((line) => `  -${line}`),
    "  --- pnpm ---",
    ...regeneratedMiddle.map((line) => `  +${line}`),
  ].join("\n");
}
