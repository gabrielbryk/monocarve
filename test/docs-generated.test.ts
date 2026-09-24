/**
 * docs/cli-reference.md and docs/configuration.md are generated from the
 * command registry and the config schema (scripts/docs/generate.ts). This test
 * regenerates both in memory and refuses a committed copy that has drifted.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { EXIT_CODES } from "../scripts/docs/cli-notes.ts";
import { configFields, MINIMAL_CONFIG } from "../scripts/docs/configuration.ts";
import { generatedDocs } from "../scripts/docs/generate.ts";
import { GENERATED_BANNER, REPO_ROOT } from "../scripts/docs/markdown.ts";
import { COMMANDS } from "../src/commands/index.ts";
import { monocarveConfigSchema } from "../src/config/schema.ts";

const generated = generatedDocs();

function committed(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), "utf8");
}

function firstDifference(expected: string, actual: string): string {
  const want = expected.split("\n");
  const have = actual.split("\n");
  const line = want.findIndex((text, index) => text !== have[index]);
  const at = line === -1 ? want.length : line;
  return `first difference at line ${at + 1}:\n  generated: ${JSON.stringify(want[at] ?? "<end of file>")}\n  committed: ${JSON.stringify(have[at] ?? "<end of file>")}`;
}

describe("generated documentation", () => {
  for (const [path, contents] of generated) {
    test(`${path} matches its generator`, () => {
      const actual = committed(path);
      if (actual !== contents) throw new Error(`${path} is stale: run \`bun run docs:generate\` and commit the result.\n${firstDifference(contents, actual)}`);
      expect(actual.startsWith(`${GENERATED_BANNER}\n`)).toBeTrue();
    });
  }

  test("generation is deterministic", () => {
    expect(generatedDocs()).toEqual(generated);
  });

  test("the CLI reference documents every command and every accepted flag", () => {
    const reference = generated.get("docs/cli-reference.md") ?? "";
    for (const [name, spec] of Object.entries(COMMANDS)) {
      expect(reference).toContain(`### \`${name}\``);
      for (const flag of spec.flags) expect(reference).toContain(`\`--${flag.name}`);
    }
  });

  test("hand-written reference notes keep their authority boundaries", () => {
    const reference = (generated.get("docs/cli-reference.md") ?? "").replace(/\s+/gu, " ");
    for (const phrase of [
      "`--package-root` is an optional override",
      "`targetMode`",
      "exact top-level and nested move targets",
      "Assessment qualification has four outcomes",
      "mandatory raw scanner reports",
      "`--graph` reports are intentionally refused",
      "conservative completeness rule",
      "It does not steal stale locks or perform",
      "does not alter plan identity",
      "Reviewed boundary baseline",
    ])
      expect(reference).toContain(phrase);
  });

  test("the exit-code table matches the codes main() documents", () => {
    const cli = readFileSync(resolve(REPO_ROOT, "src/cli.ts"), "utf8");
    const block = /\* Exit codes[^\n]*\n([\s\S]*?)\*\/\nexport async function main/u.exec(cli)?.[1] ?? "";
    const documented = [...block.matchAll(/^ \* {3}(\d+) /gmu)].map((match) => match[1] ?? "");
    expect(documented.length).toBeGreaterThan(0);
    const tabled = EXIT_CODES.flatMap((entry) => entry.code.split(" / "));
    for (const code of documented) expect(tabled).toContain(code);
    // Beyond main()'s codes, only the interrupted-apply signal exits (128 + SIGINT/SIGTERM).
    expect(tabled.filter((code) => !documented.includes(code)).toSorted()).toEqual(["130", "143"]);
  });

  test("every config key has a description, and the minimal example is a valid config", () => {
    const undocumented = [...configFields().values()].filter((field) => field.description === "").map((field) => field.path);
    expect(undocumented).toEqual([]);
    expect(monocarveConfigSchema.safeParse(MINIMAL_CONFIG).success).toBeTrue();
  });
});
