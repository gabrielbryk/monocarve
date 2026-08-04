/**
 * Scratch git repositories for the transaction tests.
 *
 * Every git invocation here runs with a scrubbed environment. This is not
 * defensive tidiness: `GIT_INDEX_FILE`, `GIT_DIR`, and `GIT_WORK_TREE` are
 * inherited by child processes, and when a test suite runs under a git hook —
 * a pre-commit hook running the test command, say — those variables point at
 * the *host* repository. A fixture's `git add -A` would then write into the
 * host repository's index while `cwd` looked entirely correct, destroying
 * staged work with no error message. Scrubbing them makes `cwd` the only thing
 * that selects a repository.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { scrubbedGitEnv } from "../../src/util/git.ts";
import { parseConfig, type MonocarveConfig, type MonocarveUserConfig } from "../../src/config.ts";
import { CONFIG_BASENAME } from "../../src/branding.ts";

export function fixtureGit(root: string, ...args: string[]): string {
  // `cwd` is still set for commands and hooks that need the fixture's files,
  // but it is not sufficient for a test helper: a misspelled fixture root can
  // make Git walk upward and discover the repository that contains the test
  // scratch directory.  In particular, `git config user.name …` would then
  // silently rewrite that enclosing repository's local identity.  Pin every
  // post-init invocation to this fixture's own git directory and worktree.
  //
  // `init` is deliberately the one exception. There is no `.git` to pin until
  // it succeeds, and `git init` creates one in its cwd rather than discovering
  // a parent repository.
  const commandIndex = assertFixtureCommandArgs(args);
  const command = args[commandIndex] === "init" ? args : fixtureGitCommand(root, args, commandIndex);
  return execFileSync("git", command, { cwd: root, encoding: "utf8", env: fixtureGitEnv() }).trim();
}

/**
 * Test fixtures must not inherit a caller's injected Git configuration. It can
 * select a different config file or inject `core.worktree` just as surely as a
 * command-line selector can. Production Git keeps non-redirecting environment
 * variables by design; fixture setup is stricter because its identity is test
 * data and must not write outside the fixture it creates.
 */
function fixtureGitEnv(): NodeJS.ProcessEnv {
  const env = scrubbedGitEnv();
  for (const name of Object.keys(env)) {
    if (name.startsWith("GIT_CONFIG_")) delete env[name];
  }
  return env;
}

function fixtureGitCommand(root: string, args: readonly string[], commandIndex: number): string[] {
  const repository = fixtureRepository(root);
  if (repository === null) {
    throw new Error(`fixture repository does not exist at ${root}`);
  }

  // Fixture identity is test data. Force writes to the fixture-local config so
  // a future caller cannot accidentally turn a test identity into a host or
  // global setting by relying on Git's implicit config scope.
  const scopedArgs = fixtureConfigArgs(args, commandIndex);
  return ["--git-dir", repository.gitDir, "--work-tree", repository.workTree, ...scopedArgs];
}

interface FixtureRepository {
  readonly gitDir: string;
  readonly workTree: string;
}

/**
 * Resolve the actual git directory, rather than assuming `${root}/.git` is a
 * directory. Linked worktrees have a `.git` *file* pointing at metadata in the
 * primary repository. The top-level equality check is what prevents Git's
 * normal upward discovery from turning a nested typo into a write to its host.
 */
function fixtureRepository(root: string): FixtureRepository | null {
  try {
    const output = execFileSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree", "--show-toplevel", "--absolute-git-dir"], {
      cwd: root,
      encoding: "utf8",
      env: fixtureGitEnv(),
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const [insideWorkTree, topLevel, gitDir] = output.split("\n");
    if (insideWorkTree !== "true" || topLevel === undefined || gitDir === undefined) return null;
    const workTree = realpathSync(topLevel);
    if (workTree !== realpathSync(root)) return null;
    return { workTree, gitDir: resolve(root, gitDir) };
  } catch {
    return null;
  }
}

function fixtureConfigArgs(args: readonly string[], commandIndex: number): string[] {
  if (args[commandIndex] !== "config") return [...args];
  const externalScope = args.find(
    (arg) =>
      arg === "--global" ||
      arg === "--system" ||
      arg === "--worktree" ||
      arg === "--file" ||
      arg === "-f" ||
      arg === "--blob" ||
      arg.startsWith("--global=") ||
      arg.startsWith("--system=") ||
      arg.startsWith("--file=") ||
      arg.startsWith("--blob="),
  );
  if (externalScope !== undefined) {
    throw new Error(`fixture git config may not use ${externalScope}; fixture config is local only`);
  }
  return args.includes("--local")
    ? [...args]
    : [...args.slice(0, commandIndex + 1), "--local", ...args.slice(commandIndex + 1)];
}

/** Reject options that would override the helper's pinned repository. */
function assertFixtureCommandArgs(args: readonly string[]): number {
  const commandIndex = gitCommandIndex(args);
  const globalArgs = args.slice(0, commandIndex);
  const selector = globalArgs.find(isRepositoryOrConfigSelector);
  if (selector !== undefined) {
    throw new Error(`fixture git may not use repository or config selector ${selector}`);
  }
  if (
    args[commandIndex] === "init" &&
    args.slice(commandIndex + 1).some((arg) => arg === "--separate-git-dir" || arg.startsWith("--separate-git-dir="))
  ) {
    throw new Error("fixture git init may not use --separate-git-dir");
  }
  return commandIndex;
}

/** Index of the Git subcommand after any leading global options. */
function gitCommandIndex(args: readonly string[]): number {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === undefined || !arg.startsWith("-")) return index;
    // These benign Git-global options consume one following value when it is
    // separate. Skip that value so it cannot be mistaken for the subcommand.
    if (["--exec-path", "--namespace", "--super-prefix", "--list-cmds"].includes(arg)) index += 2;
    else index += 1;
  }
  return index;
}

function isRepositoryOrConfigSelector(arg: string): boolean {
  return (
    arg === "--git-dir" ||
    arg === "--work-tree" ||
    arg === "-C" ||
    arg === "-c" ||
    arg === "--config-env" ||
    arg.startsWith("--git-dir=") ||
    arg.startsWith("--work-tree=") ||
    (arg.startsWith("-C") && arg.length > 2) ||
    (arg.startsWith("-c") && arg.length > 2) ||
    arg.startsWith("--config-env=")
  );
}

export function write(root: string, path: string, contents: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
}

export function read(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8");
}

const created: string[] = [];

/** A committed git repository containing `files`. Registered for cleanup. */
export function fixtureRepo(files: Record<string, string>, branch = "extraction-fixture"): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "monocarve-fixture-")));
  created.push(root);
  fixtureGit(root, "init", "-q", "-b", branch);
  fixtureGit(root, "config", "user.email", "fixture@example.invalid");
  fixtureGit(root, "config", "user.name", "Monocarve Fixture");
  fixtureGit(root, "config", "commit.gpgsign", "false");
  for (const [path, contents] of Object.entries(files)) write(root, path, contents);
  fixtureGit(root, "add", "-A");
  fixtureGit(root, "commit", "-qm", "test: seed extraction fixture");
  return root;
}

export function cleanupFixtures(): void {
  while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true });
}

/** A temporary directory outside every repository, for simulation worktrees. */
export function scratchDirectory(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "monocarve-scratch-")));
  created.push(path);
  return path;
}

/** Validated config for a fixture repository, written into it as JSON. */
export function fixtureConfig(root: string, overrides: Partial<MonocarveUserConfig> = {}): MonocarveConfig {
  const base: MonocarveUserConfig = {
    applications: [
      {
        name: "api",
        sourceRoot: "apps/api/src",
        tsconfig: "apps/api/tsconfig.json",
        packageName: "@acme/api",
        compositionRoots: [],
      },
    ],
    packageRoots: ["libs"],
    packageScope: "@acme/",
    packageManager: "pnpm",
    taskRunner: "none",
    guardedBranches: ["main", "develop"],
    gates: { package: [], project: [], workspace: ["true"] },
    commitTemplates: {
      plan: "chore({package}): compile extraction plan {planId}",
      move: "refactor({package}): move {fileCount} files into {packageRoot}",
      wiring: "refactor({package}): wire {package} into the workspace",
      trailer: "Extraction-Proof: simulated {planId}",
    },
    scaffoldTemplates: {
      entrypoint: "src/index.ts",
      packageJson: {
        contents: `${JSON.stringify(
          {
            name: "{package}",
            version: "0.1.0",
            private: true,
            type: "module",
            main: "./src/index.ts",
            types: "./src/index.ts",
            exports: { ".": { types: "./src/index.ts", import: "./src/index.ts", default: "./src/index.ts" } },
          },
          null,
          2,
        )}\n`,
      },
    },
    transaction: { worktreeRoot: scratchDirectory(), nodeModules: "none", cleanup: true, simulateGates: true },
    ...overrides,
  };
  const config = parseConfig(base, "<fixture>");
  const file = `${CONFIG_BASENAME}.json`;
  write(root, file, `${JSON.stringify(base, null, 2)}\n`);
  // Committed, not merely written: `apply` refuses to run against a dirty tree,
  // and an uncommitted config would make every transaction test trip that gate
  // for a reason unrelated to what it is testing.
  fixtureGit(root, "add", "--", file);
  fixtureGit(root, "commit", "-qm", "test: add fixture config");
  return config;
}
