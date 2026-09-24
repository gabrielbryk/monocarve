/**
 * Terminal help rendered from the command registry. The Markdown reference is
 * generated from the same registry; test/docs-generated.test.ts owns it.
 */
import { describe, expect, test } from "bun:test";

import { COMMAND_NAME_WIDTH, COMMANDS, GLOBAL_OPTIONS, USAGE, commandHelp } from "../src/commands/index.ts";

describe("CLI help", () => {
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

  test("plan review help exposes its read-only approval boundary", () => {
    const help = commandHelp(COMMANDS["plan-review"]!);
    expect(help).toContain("plan-review --plan <path>");
    expect(help).toContain("--approval-subject <subject>");
    expect(help).toContain("without changing the workspace");
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
    expect(assess).toContain("usage: monocarve assess --app <name> --evidence-dir <path>");
    expect(assess).toContain("--replay <bundle>");
    expect(assess).toContain("--file <path> ... | --split-hotspots <n>");
    expect(assess).toContain("Bare --graph replay and mutation-only flags are refused");
    expect(split).toContain("monocarve split-candidates --file <path> [--out <path>]");
    expect(split).toContain("--app <name> --evidence-dir <path>");
    expect(split).toContain("The legacy single-file form is unchanged");
  });
});
