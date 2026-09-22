import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { APPLY_LOCK_FILENAME, APPLY_STATE_FILENAME } from "../src/branding.ts";
import type { ExtractionManifest } from "../src/plan/manifest.ts";
import { applyTransactionStatus, beginApplyTransaction, recoverApplyTransaction, type ApplyTransactionState } from "../src/transaction/apply-state.ts";
import { cleanupFixtures, fixtureGit, fixtureRepo } from "./support/fixture-repo.ts";

afterEach(cleanupFixtures);

function manifest(root: string): ExtractionManifest {
  return {
    planId: "p-test",
    baselineCommit: fixtureGit(root, "rev-parse", "HEAD"),
    commits: { plan: { subject: "plan" }, move: { subject: "move" }, wiring: { subject: "wire" } },
  } as ExtractionManifest;
}

describe("durable apply transaction state", () => {
  test("serializes committing applies and reports the live owner", () => {
    const root = fixtureRepo({ "README.md": "fixture\n" });
    const active = beginApplyTransaction(root, manifest(root), ".plans/p-test.json");
    expect(() => beginApplyTransaction(root, manifest(root), ".plans/p-test.json")).toThrow("apply transaction p-test is simulating");
    expect(applyTransactionStatus(root)).toMatchObject({ active: true, ownerAlive: true, state: { phase: "simulating" } });
    active.complete();
    active.release();
    expect(applyTransactionStatus(root)).toEqual({ active: false, ownerAlive: false });
  });

  test("releases only a stopped matching owner and guides move-boundary resume", () => {
    const root = fixtureRepo({ "README.md": "fixture\n" });
    const startHead = fixtureGit(root, "rev-parse", "HEAD");
    fixtureGit(root, "commit", "--allow-empty", "-qm", "move");
    const stale: ApplyTransactionState = {
      schema: "apply-transaction-v1",
      planId: "p-test",
      manifestPath: ".plans/p-test.json",
      baselineCommit: startHead,
      startHead,
      ownerPid: 2_000_000_000,
      ownerToken: "stopped-owner",
      phase: "applying",
    };
    const gitDir = join(root, ".git");
    writeFileSync(join(gitDir, APPLY_STATE_FILENAME), `${JSON.stringify(stale)}\n`);
    writeFileSync(join(gitDir, APPLY_LOCK_FILENAME), `${JSON.stringify(stale)}\n`);

    expect(() => recoverApplyTransaction(root, { ...manifest(root), planId: "different-plan" })).toThrow("belongs to plan p-test");
    expect(recoverApplyTransaction(root, manifest(root)).next).toEqual(["monocarve", "apply", "--plan", ".plans/p-test.json", "--commit", "--resume"]);
    expect(applyTransactionStatus(root)).toEqual({ active: false, ownerAlive: false });
    const resumed = beginApplyTransaction(root, manifest(root), ".plans/p-test.json");
    resumed.complete();
    resumed.release();
  });
});
