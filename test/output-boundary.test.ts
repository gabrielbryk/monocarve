import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { committedWorkspace, runIn } from "./support/cli.ts";
import { cleanupFixtures } from "./support/fixture-repo.ts";

afterEach(cleanupFixtures);

test("every discovery output remains inside the workspace", async () => {
  const root = committedWorkspace();
  const escaped = join(dirname(root), "escaped-scan.json");
  const result = await runIn(root, "scan", "--out", "../escaped-scan.json", "--no-cache");
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("workspace-relative");
  expect(existsSync(escaped)).toBeFalse();
}, 30_000);
