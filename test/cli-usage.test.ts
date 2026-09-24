/**
 * What the executable prints, and exits with, for a malformed invocation.
 *
 * Runs in a directory with no config anywhere above it, so any command that got
 * past argument validation fails on config discovery instead: exit 1 and the
 * config hint. That makes "usage is checked before config is loaded" directly
 * observable — a usage error here must be 64, never the config failure.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { cleanupFixtures, scratchDirectory } from "./support/fixture-repo.ts";

const CLI = resolve(import.meta.dir, "../src/cli.ts");

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const EMPTY = join(scratchDirectory(), "no-config");
mkdirSync(EMPTY, { recursive: true });

async function run(...args: string[]): Promise<RunResult> {
  const child = Bun.spawn(["bun", CLI, ...args], { cwd: EMPTY, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

function expectUsageError(result: RunResult, message: string): void {
  expect(result.code).toBe(64);
  expect(result.stdout).toBe("");
  expect(result.stderr.split("\n")[0]).toBe(`monocarve: ${message}`);
  expect(result.stderr).not.toContain("no config found");
  expect(result.stderr).not.toMatch(/^\s+at /mu);
}

describe("cli usage failures", () => {
  afterAll(() => {
    cleanupFixtures();
  });

  test("an unknown flag fails before config is loaded, naming the closest flag", async () => {
    const typo = await run("apply", "--plan", "p.json", "--comit");
    expectUsageError(typo, "unknown option --comit for `monocarve apply`");
    expect(typo.stderr).toContain("hint: did you mean --commit?");
    expect(typo.stderr).toContain("usage: monocarve apply --plan <path>");

    expectUsageError(await run("scan", "--bogus"), "unknown option --bogus for `monocarve scan`");
    expectUsageError(await run("apply", "--plan"), "--plan requires a value");
    expectUsageError(await run("plan", "--candidate", "c", "--write", "false"), '--write is a switch and takes no value (got "false")');

    // The control: the same command, well formed, gets past validation and
    // fails on the missing config instead.
    const valid = await run("apply", "--plan", "p.json", "--commit");
    expect(valid.code).toBe(1);
    expect(valid.stderr).toContain("no config found");
  }, 30_000);

  test("config failures render as `monocarve: <message>` with a hint, not an error class", async () => {
    const result = await run("--json", "scan");
    expect(result.code).toBe(1);
    const lines = result.stderr.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^monocarve: no config found in /u);
    expect(lines[0]).not.toContain("ConfigError");
    expect(lines[1]).toContain('hint: create monocarve.config.ts exporting `defineConfig({ ... })` from "monocarve/config"');
    expect(lines[1]).toContain("monocarve config-doctor");
  }, 30_000);

  test("global flags before the command do not swallow it", async () => {
    // `--json scan` used to parse as json="scan", run nothing, and exit 0.
    const invocations = [
      ["--json", "scan"],
      ["scan", "--json"],
      ["--cwd", EMPTY, "scan"],
      ["scan", "--cwd", EMPTY],
    ];
    const results = await Promise.all(invocations.map((argv) => run(...argv)));
    for (const [index, result] of results.entries()) {
      expect(result.code, invocations[index]?.join(" ")).toBe(1);
      expect(result.stderr).toContain("no config found");
    }
  }, 60_000);

  test("no command: bare and --help succeed, anything else is a usage error", async () => {
    const bare = await run();
    expect(bare.code).toBe(0);
    expect(bare.stdout).toContain("usage: monocarve [global options] <command> [options]");

    const help = await run("--help");
    expect(help.code).toBe(0);
    expect(help.stdout).toBe(bare.stdout);

    const commandHelp = await run("apply", "--help");
    expect(commandHelp.code).toBe(0);
    expect(commandHelp.stdout).toContain("usage: monocarve apply --plan <path>");

    const json = await run("--json");
    expect(json.code).toBe(64);
    expect(json.stdout).toBe("");
    expect(json.stderr).toStartWith("monocarve: no command given\n");
    expect(json.stderr).toContain("commands:");

    expectUsageError(await run("--bogus"), "unknown option --bogus");
  }, 30_000);

  test("unknown commands suggest the closest one", async () => {
    const result = await run("scna");
    expectUsageError(result, 'unknown command "scna"');
    expect(result.stderr).toContain("hint: did you mean `monocarve scan`?");
    expect(result.stderr).not.toContain("usage:");
  }, 30_000);

  test("version wins wherever it appears", async () => {
    const results = await Promise.all([run("--version"), run("-v"), run("scan", "--version")]);
    for (const result of results) {
      expect(result.code).toBe(0);
      expect(result.stdout).toStartWith("monocarve ");
    }
  }, 30_000);
});
