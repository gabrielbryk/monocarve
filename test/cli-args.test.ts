/**
 * Strict argument parsing against the command registry.
 *
 * Every negative here was a silent success before: an unknown flag was ignored,
 * a switch swallowed the next token (`--json scan` ran nothing), and
 * `--write false` meant "write". Each is paired with the valid spelling so a
 * parser that refused everything would fail too.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parseArgs } from "../src/cli.ts";
import { ArgumentError } from "../src/cli/args.ts";
import { closestMatch, commandFlags, editDistance, flagsFromUsage, GLOBAL_FLAGS } from "../src/cli/flags.ts";
import { COMMAND_NAME_WIDTH, COMMANDS, USAGE, commandHelp } from "../src/commands/index.ts";

function registered(name: string): (typeof COMMANDS)[string] {
  const spec = COMMANDS[name];
  if (spec === undefined) throw new Error(`no registered command ${name}`);
  return spec;
}

function failure(argv: readonly string[]): ArgumentError {
  try {
    parseArgs(argv);
  } catch (error) {
    if (error instanceof ArgumentError) return error;
    throw error;
  }
  throw new Error(`expected ${JSON.stringify(argv)} to be rejected`);
}

describe("flag declarations derived from usage", () => {
  test("placeholders make value flags, bare flags are switches, repeats are repeatable", () => {
    const kinds = Object.fromEntries(flagsFromUsage(registered("plan").usage).map((spec) => [spec.name, spec.kind]));
    expect(kinds).toMatchObject({
      candidate: "value",
      source: "repeatable",
      "public-surface": "value",
      write: "boolean",
      "commit-approval": "boolean",
      json: "boolean",
    });
    expect(Object.fromEntries(flagsFromUsage("x --plan <a>=<b> [--plan <a>=<b> ...] [--older-than <n>[m|h|d]]").map((s) => [s.name, s.kind]))).toEqual({
      plan: "repeatable",
      "older-than": "value",
    });
  });

  test("each line of a multi-form usage is its own invocation", () => {
    // `--out` and `--write` appear on several campaign lines; that is not repetition.
    const kinds = Object.fromEntries(registered("campaign").flags.map((spec) => [spec.name, spec.kind]));
    expect(kinds.out).toBe("value");
    expect(kinds.write).toBe("boolean");
    expect(kinds.campaign).toBe("value");
  });

  test("contradictory declarations fail at registration", () => {
    expect(() => flagsFromUsage("x [--out <path>]\nx [--out]")).toThrow("both as a switch");
    expect(() => commandFlags("x [--json <mode>]")).toThrow("global boolean");
    expect(() => commandFlags("x [--write]", { refused: ["write"] })).toThrow("both accepted and refused");
    expect(() => commandFlags("x [--write]", { repeatable: ["write"] })).toThrow("not a value flag");
  });

  test("every flag a usage line shows is accepted by that command", () => {
    for (const [name, spec] of Object.entries(COMMANDS)) {
      const accepted = new Set(spec.flags.filter((flag) => flag.kind !== "refused").map((flag) => flag.name));
      for (const match of spec.usage.matchAll(/--([a-z][a-z0-9-]*)/gu)) {
        expect(accepted.has(match[1] ?? ""), `${name} --${match[1]}`).toBeTrue();
      }
    }
  });

  test("every flag a command module reads is accepted somewhere", () => {
    // A cheap drift guard: a handler reading a flag no command declares can never see it.
    const accepted = new Set([...GLOBAL_FLAGS, ...Object.values(COMMANDS).flatMap((spec) => spec.flags)].map((flag) => flag.name));
    const directory = resolve(import.meta.dir, "../src/commands");
    const read = new Set<string>();
    for (const file of readdirSync(directory).filter((entry) => entry.endsWith(".ts"))) {
      const source = readFileSync(join(directory, file), "utf8");
      for (const match of source.matchAll(/(?:flag(?:String|Strings|Bool|Number)|required(?:Flag)?)\(args, "([a-z][a-z0-9-]*)"/gu)) read.add(match[1] ?? "");
    }
    expect(read.size).toBeGreaterThan(40);
    expect([...read].filter((name) => !accepted.has(name))).toEqual([]);
  });
});

describe("parsing", () => {
  test("global flags work before or after the command, and switches never consume a token", () => {
    for (const argv of [
      ["--json", "scan"],
      ["scan", "--json"],
      ["-j", "scan"],
      ["scan", "-j"],
    ]) {
      const args = parseArgs(argv);
      expect(args.command).toBe("scan");
      expect(args.flags.get("json")).toBeTrue();
      expect(args.positionals).toEqual([]);
    }
    const before = parseArgs(["--cwd", "/work", "--config", "c.ts", "apply", "--plan", "p.json", "--commit"]);
    const after = parseArgs(["apply", "--plan", "p.json", "--commit", "--cwd", "/work", "--config=c.ts"]);
    for (const args of [before, after]) {
      expect(args.command).toBe("apply");
      expect(Object.fromEntries(args.flags)).toEqual({ cwd: "/work", config: "c.ts", plan: "p.json", commit: true });
    }
  });

  test("repeatable flags keep order; a single-value flag may not be repeated", () => {
    const args = parseArgs(["plan", "--candidate", "c-1", "--graph", "web=a.json", "--graph=api=b.json", "--source", "a.ts", "--source", "b.ts"]);
    expect(args.repeated.get("graph")).toEqual(["web=a.json", "api=b.json"]);
    expect(args.repeated.get("source")).toEqual(["a.ts", "b.ts"]);
    const repeated = failure(["apply", "--plan", "a.json", "--plan", "b.json"]);
    expect(repeated.message).toContain("pass --plan only once");
    expect(repeated.command).toBe("apply");
  });

  test("unknown flags are refused with the closest valid flag", () => {
    const typo = failure(["apply", "--plan", "p.json", "--comit"]);
    expect(typo.message).toBe("unknown option --comit for `monocarve apply`");
    expect(typo.hint).toContain("did you mean --commit?");
    expect(typo.command).toBe("apply");

    const bogus = failure(["scan", "--bogus"]);
    expect(bogus.message).toContain("unknown option --bogus");
    expect(bogus.hint).not.toContain("did you mean");

    // A flag another command accepts is still unknown here.
    expect(failure(["scan", "--commit"]).message).toContain("unknown option --commit");
    // Refused flags are never suggested.
    expect(failure(["apply", "--plan", "p", "--skip-simulatio"]).hint).not.toContain("--skip-simulation");
    expect(failure(["scan", "-x"]).message).toContain("unknown option -x");
  });

  test("before the command only global flags are known", () => {
    const bogus = failure(["--bogus"]);
    expect(bogus.message).toBe("unknown option --bogus");
    expect(bogus.command).toBeUndefined();

    const misplaced = failure(["--plan", "p.json", "apply"]);
    expect(misplaced.message).toContain("--plan is a command option and must follow the command name");
    expect(misplaced.hint).toContain("monocarve apply --plan");
  });

  test("switches take no value", () => {
    for (const argv of [
      ["plan", "--candidate", "c", "--write", "false"],
      ["plan", "--candidate", "c", "--write=false"],
      ["plan", "--candidate", "c", "--write=true"],
      ["scan", "--no-cache", "no"],
    ]) {
      const error = failure(argv);
      expect(error.message).toMatch(/--(write|no-cache) is a switch and takes no value/u);
    }
    expect(parseArgs(["plan", "--candidate", "c", "--write"]).flags.get("write")).toBeTrue();
  });

  test("value flags require a value", () => {
    expect(failure(["apply", "--plan"]).message).toBe("--plan requires a value");
    expect(failure(["plan", "--out", "--write"]).message).toBe("--out requires a value");
    expect(failure(["plan", "--out", "-j"]).message).toBe("--out requires a value");
    // A value may still start with a dash when it is not an option.
    expect(parseArgs(["portfolio", "--limit", "-1"]).flags.get("limit")).toBe("-1");
    expect(parseArgs(["plan", "--out=--odd"]).flags.get("out")).toBe("--odd");
  });

  test("handler-refused and retired flags reach an explanation, not 'unknown'", () => {
    // Parsed so the handler can explain its own refusal.
    expect(parseArgs(["apply", "--plan", "p", "--skip-simulation"]).flags.get("skip-simulation")).toBeTrue();
    expect(parseArgs(["assess", "--app", "web", "--write", "--json"]).flags.get("write")).toBeTrue();
    expect(parseArgs(["evacuate", "--apply"]).flags.get("apply")).toBeTrue();
    // Retired everywhere.
    expect(failure(["scan", "--allow-dirty"]).message).toContain("--allow-dirty is no longer supported");
  });

  test("unknown commands suggest the closest command", () => {
    const error = failure(["scna"]);
    expect(error.message).toBe('unknown command "scna"');
    expect(error.hint).toContain("did you mean `monocarve scan`?");
    expect(failure(["frobnicate"]).hint).not.toContain("did you mean");
  });

  test("positionals and the -- terminator", () => {
    const args = parseArgs(["check", "import-extensions"]);
    expect(args.positionals).toEqual(["import-extensions"]);
    expect(parseArgs(["campaign", "status", "--campaign", "c.json", "--", "--not-a-flag"]).positionals).toEqual(["status", "--not-a-flag"]);
  });
});

describe("suggestions", () => {
  test("edit distance and closest match", () => {
    expect(editDistance("comit", "commit")).toBe(1);
    expect(editDistance("", "abc")).toBe(3);
    expect(closestMatch("comit", ["commit", "resume"])).toBe("commit");
    expect(closestMatch("verify", ["verify-lockfile", "resume"])).toBe("verify-lockfile");
    expect(closestMatch("zzzzzz", ["commit", "resume"])).toBeUndefined();
  });
});

describe("help rendering", () => {
  test("the command listing pads to the longest name, so no summary collides with its name", () => {
    const longest = Object.keys(COMMANDS).reduce((a, b) => (b.length > a.length ? b : a));
    expect(COMMAND_NAME_WIDTH).toBe(longest.length);
    expect(longest.length).toBeGreaterThan(16);
    for (const [name, spec] of Object.entries(COMMANDS)) {
      expect(USAGE).toContain(`  ${name}${" ".repeat(COMMAND_NAME_WIDTH - name.length + 2)}${spec.summary}`);
    }
  });

  test("help names accepted flags the usage line omits", () => {
    expect(commandHelp(registered("next"))).toContain("also accepts: --out <value>, --include-extracted");
    expect(commandHelp(registered("apply"))).not.toContain("also accepts");
    // Refused flags are not advertised.
    expect(commandHelp(registered("apply"))).not.toContain("--skip-simulation <");
  });
});
