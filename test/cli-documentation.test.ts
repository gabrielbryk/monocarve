import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { COMMAND_NAME_WIDTH, COMMANDS, GLOBAL_OPTIONS, USAGE, commandHelp } from "../src/commands/index.ts";

const reference = readFileSync(resolve(import.meta.dir, "../docs/cli-reference.md"), "utf8");

describe("CLI documentation", () => {
  test("top-level help is derived from every registered command", () => {
    for (const [name, spec] of Object.entries(COMMANDS)) {
      expect(USAGE).toContain(`  ${name.padEnd(COMMAND_NAME_WIDTH)}  ${spec.summary}`);
    }
    expect(USAGE).toContain(GLOBAL_OPTIONS);
  });

  test("command help carries exact usage, safety detail, and global options", () => {
    for (const spec of Object.values(COMMANDS)) {
      const help = commandHelp(spec);
      expect(help).toContain(`usage: ${spec.usage}`);
      expect(help).toContain(GLOBAL_OPTIONS);
      expect(spec.details?.length ?? 0).toBeGreaterThan(20);
    }
  });

  test("the repository reference names every command and documented flag", () => {
    for (const [name, spec] of Object.entries(COMMANDS)) {
      expect(reference).toContain(`\`${name}\``);
      for (const flag of spec.usage.match(/--[a-z][a-z-]*/g) ?? []) expect(reference).toContain(flag);
    }
    expect(reference).toContain("existing package");
    expect(reference).toContain("`--package-root` is an optional override");
    expect(reference).toContain("`targetMode`");
    expect(reference).toContain("Exit codes");
  });

  test("plan review help exposes its read-only approval boundary", () => {
    const help = commandHelp(COMMANDS["plan-review"]!);
    expect(help).toContain("plan-review --plan <path>");
    expect(help).toContain("--approval-subject <subject>");
    expect(help).toContain("without changing the workspace");
    expect(reference).toContain("exact top-level and nested move targets");
  });

  test("apply help directs landing workflows through one committed invocation", () => {
    const help = commandHelp(COMMANDS.apply!);
    expect(help).toContain("Use --commit as the default landing path");
    expect(help).toContain("simulates once");
    expect(help).toContain("do not run it immediately before a committed apply");
    expect(help).toContain("no simulation evidence is cached");
  });

  test("assessment and batch signatures preserve their documented authority boundaries", () => {
    const assess = commandHelp(COMMANDS.assess!);
    const split = commandHelp(COMMANDS["split-candidates"]!);
    const normalizedReference = reference.replace(/\s+/gu, " ");
    expect(assess).toContain("usage: monocarve assess --app <name> --evidence-dir <path>");
    expect(assess).toContain("--replay <bundle>");
    expect(assess).toContain("--file <path> ... | --split-hotspots <n>");
    expect(assess).toContain("Bare --graph replay and mutation-only flags are refused");
    expect(split).toContain("monocarve split-candidates --file <path> [--out <path>]");
    expect(split).toContain("--app <name> --evidence-dir <path>");
    expect(split).toContain("The legacy single-file form is unchanged");
    for (const phrase of [
      "Assessment qualification has four outcomes",
      "mandatory raw scanner reports",
      "`--graph` reports are intentionally refused",
      "conservative completeness rule",
      "It does not steal stale locks or perform",
      "does not alter plan identity",
    ])
      expect(normalizedReference).toContain(phrase);
  });
});
