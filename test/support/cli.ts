/** Shared process and checkout helpers for CLI integration suites. */

import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { fixtureGit, scratchDirectory } from "./fixture-repo.ts";

export const ROOT = resolve(import.meta.dir, "..", "..");
export const FIXTURE = join(ROOT, "fixtures/basic-monorepo");
export const CLI = join(ROOT, "src/cli.ts");
export const PLAN_DIR = join(FIXTURE, ".monocarve");

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runIn(cwd: string, ...args: string[]): Promise<RunResult> {
  const child = Bun.spawn(["bun", CLI, "--cwd", cwd, ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { code, stdout, stderr };
}

export async function run(...args: string[]): Promise<RunResult> {
  return runIn(FIXTURE, ...args);
}

export async function runJsonIn<T>(cwd: string, ...args: string[]): Promise<T> {
  const result = await runIn(cwd, ...args);
  if (result.code !== 0) throw new Error(`${args.join(" ")} exited ${result.code}:\n${result.stderr}`);
  return JSON.parse(result.stdout) as T;
}

export async function runJson<T>(...args: string[]): Promise<T> {
  return runJsonIn<T>(FIXTURE, ...args);
}

export function committedWorkspace(): string {
  const root = join(scratchDirectory(), "workspace");
  cpSync(FIXTURE, root, { recursive: true });
  rmSync(join(root, ".monocarve"), { recursive: true, force: true });
  writeFileSync(join(root, ".gitignore"), ".monocarve/\n");
  fixtureGit(root, "init", "-q", "-b", "verify-fixture");
  fixtureGit(root, "config", "user.email", "fixture@example.invalid");
  fixtureGit(root, "config", "user.name", "Monocarve Fixture");
  fixtureGit(root, "config", "commit.gpgsign", "false");
  fixtureGit(root, "add", "-A");
  fixtureGit(root, "commit", "-qm", "test: seed verify workspace");
  return root;
}

export function configureAllowedDirtyPaths(workspace: string, paths: readonly string[]): void {
  const configPath = join(workspace, "monocarve.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { transaction?: Record<string, unknown> };
  config.transaction = { ...config.transaction, allowDirtyPaths: paths };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  fixtureGit(workspace, "add", "--", "monocarve.config.json");
  fixtureGit(workspace, "commit", "-qm", "test: allow unrelated dirty paths");
}

export { existsSync, readFileSync, writeFileSync };
