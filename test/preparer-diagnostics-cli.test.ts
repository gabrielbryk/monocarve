import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";

import { cleanupFixtures, fixtureGit } from "./support/fixture-repo.ts";
import { committedWorkspace, readFileSync, runIn, writeFileSync } from "./support/cli.ts";

afterAll(cleanupFixtures);

test("preparer-plan preserves an early verify diagnostic in JSON-mode CLI errors", async () => {
  const root = committedWorkspace();
  const configPath = join(root, "monocarve.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const diagnostic = "complexity ratchet: apps/web/src/types.ts score 47 exceeds 32";
  config.preparers = [{
    id: "diagnostic-proof",
    phase: "pre-extraction",
    command: "printf 'export interface Point { x: number; y: number }\\n' > {sourcePath}",
    outputs: ["{sourcePath}"],
    verify: `printf '${diagnostic}\\n'; yes 'unrelated gate noise' | head -n 900; printf 'gate summary failed\\n' >&2; exit 23`,
    commit: { subject: "refactor: diagnostic proof" },
  }];
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  fixtureGit(root, "add", "--", "monocarve.config.json");
  fixtureGit(root, "commit", "-qm", "test: configure diagnostic preparer");

  const result = await runIn(root, "preparer-plan", "--preparer", "diagnostic-proof", "--source", "apps/web/src/types.ts", "--json");

  expect(result.code).toBe(1);
  expect(result.stderr).toContain(diagnostic);
  expect(result.stderr).toContain("gate summary failed");
  expect(result.stderr).toContain("exit 23");
  expect(result.stderr.length).toBeLessThanOrEqual(8_300);
}, 30_000);
