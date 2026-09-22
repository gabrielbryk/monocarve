import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { recoverStaleCampaignLedgerLock } from "../src/commands/campaign-ledger-file.ts";
import { committedWorkspace } from "./support/cli.ts";
import { cleanupFixtures } from "./support/fixture-repo.ts";

afterEach(cleanupFixtures);

test("campaign ledger recovers a dead writer that owned the prior ledger", () => {
  const root = committedWorkspace();
  const target = join(root, ".monocarve/plans/recovery.json");
  const pid = 2_147_483_647;
  const backup = join(join(root, ".monocarve/plans"), `.recovery.json.${pid}.owned.${randomUUID()}.tmp`);
  mkdirSync(join(root, ".monocarve/plans"), { recursive: true });
  writeFileSync(backup, "reviewed ledger\n");
  writeFileSync(`${target}.lock`, `${JSON.stringify({ pid, backup })}\n`);
  expect(recoverStaleCampaignLedgerLock(target)).toBeTrue();
  expect(readFileSync(target, "utf8")).toBe("reviewed ledger\n");
  expect(existsSync(backup)).toBeFalse();
  expect(existsSync(`${target}.lock`)).toBeFalse();
});

test("campaign recovery refuses an untrusted backup path", () => {
  const root = committedWorkspace();
  const target = join(root, ".monocarve/plans/recovery.json");
  const outside = join(root, "package.json");
  mkdirSync(join(root, ".monocarve/plans"), { recursive: true });
  const original = readFileSync(outside, "utf8");
  writeFileSync(`${target}.lock`, `${JSON.stringify({ pid: 2_147_483_647, backup: outside })}\n`);

  expect(recoverStaleCampaignLedgerLock(target)).toBeFalse();
  expect(readFileSync(outside, "utf8")).toBe(original);
  expect(existsSync(`${target}.lock`)).toBeTrue();
});
