/** Apply-lock ownership: corrupt locks, EPERM/PID-reuse liveness, and procfs-less evidence locks. */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { publicationPaths } from "../src/assessment/evidence-destination.ts";
import { acquireLock, type LockProcessProbe } from "../src/assessment/evidence-lock.ts";
import { APPLY_LOCK_FILENAME, APPLY_STATE_FILENAME } from "../src/branding.ts";
import type { ExtractionManifest } from "../src/plan/manifest.ts";
import { ownerLiveness, procStartIdentity, systemProcessProbe, type ProcessProbe } from "../src/transaction/apply-owner.ts";
import { applyTransactionStatus, beginApplyTransaction, recoverApplyTransaction, type ApplyTransactionState } from "../src/transaction/apply-state.ts";
import { cleanupFixtures, fixtureGit, fixtureRepo, scratchDirectory } from "./support/fixture-repo.ts";
import { baseManifest, extractionFiles } from "./support/transaction-fixture.ts";

afterEach(cleanupFixtures);

const manifest = (root: string): ExtractionManifest => baseManifest(root);
const repo = (): string => fixtureRepo(extractionFiles());

function staleState(root: string, overrides: Partial<ApplyTransactionState> = {}): ApplyTransactionState {
  const head = fixtureGit(root, "rev-parse", "HEAD");
  return {
    schema: "apply-transaction-v1",
    planId: "fixture-extraction",
    manifestPath: ".plans/p-test.json",
    baselineCommit: head,
    startHead: head,
    ownerPid: 2_000_000_000,
    ownerToken: "stopped-owner",
    phase: "simulating",
    ...overrides,
  };
}

function writeTransaction(root: string, state: ApplyTransactionState, lock: string = `${JSON.stringify(state)}\n`): void {
  writeFileSync(join(root, ".git", APPLY_STATE_FILENAME), `${JSON.stringify(state)}\n`);
  writeFileSync(join(root, ".git", APPLY_LOCK_FILENAME), lock);
}

describe("corrupt apply lock", () => {
  test("names the forced recovery everywhere a corrupt lock blocks, and the forced recovery clears it", () => {
    const root = repo();
    writeFileSync(join(root, ".git", APPLY_LOCK_FILENAME), "{not json");

    expect(() => beginApplyTransaction(root, manifest(root), ".plans/p-test.json")).toThrow("--force-corrupt-lock");
    expect(() => recoverApplyTransaction(root, manifest(root))).toThrow("unreadable or corrupt");
    expect(() => recoverApplyTransaction(root, manifest(root))).toThrow("--force-corrupt-lock");
    expect(applyTransactionStatus(root)).toMatchObject({ active: true, ownerAlive: false, corruptLock: join(root, ".git", APPLY_LOCK_FILENAME) });

    const forced = recoverApplyTransaction(root, manifest(root), { forceCorruptLock: true });
    expect(forced.quarantined).toHaveLength(1);
    expect(forced.restored).toBeUndefined();
    expect(existsSync(join(root, ".git", APPLY_LOCK_FILENAME))).toBeFalse();
    expect(readdirSync(join(root, ".git")).some((name) => name.startsWith(`${APPLY_LOCK_FILENAME}.corrupt-`))).toBeTrue();
    expect(applyTransactionStatus(root)).toEqual({ active: false, ownerAlive: false });

    const next = beginApplyTransaction(root, manifest(root), ".plans/p-test.json");
    next.complete();
    next.release();
  });

  test("refuses to force a readable lock or a missing one", () => {
    const root = repo();
    expect(() => recoverApplyTransaction(root, manifest(root), { forceCorruptLock: true })).toThrow("no apply lock exists");
    const active = beginApplyTransaction(root, manifest(root), ".plans/p-test.json");
    expect(() => recoverApplyTransaction(root, manifest(root), { forceCorruptLock: true })).toThrow("is readable");
    expect(existsSync(join(root, ".git", APPLY_LOCK_FILENAME))).toBeTrue();
    active.complete();
    active.release();
  });

  test("a corrupt lock beside readable state still checks owner liveness before the forced release", () => {
    const root = repo();
    writeTransaction(root, staleState(root, { ownerPid: process.pid, ownerStart: procStartIdentity(process.pid) ?? "unknown" }), "garbage");
    expect(() => recoverApplyTransaction(root, manifest(root))).toThrow("--force-corrupt-lock");
    expect(() => recoverApplyTransaction(root, manifest(root), { forceCorruptLock: true })).toThrow("still running");
    expect(existsSync(join(root, ".git", APPLY_LOCK_FILENAME))).toBeTrue();
  });
});

describe("apply owner liveness", () => {
  test("EPERM from kill(pid, 0) means the owner exists", () => {
    const originalKill = process.kill.bind(process);
    process.kill = (pid: number, signal?: string | number): true => {
      if (pid === 2_000_000_001 && signal === 0) throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      return originalKill(pid, signal);
    };
    try {
      expect(systemProcessProbe.signal(2_000_000_001)).toBe("exists");
      const root = repo();
      writeTransaction(root, staleState(root, { ownerPid: 2_000_000_001 }));
      expect(applyTransactionStatus(root)).toMatchObject({ active: true, ownerAlive: true });
      expect(() => recoverApplyTransaction(root, manifest(root))).toThrow("still running");
      expect(existsSync(join(root, ".git", APPLY_LOCK_FILENAME))).toBeTrue();
    } finally {
      process.kill = originalKill;
    }
  });

  test("a reused PID with a different start identity is dead; an unreadable start identity is not", () => {
    const reused = repo();
    writeTransaction(reused, staleState(reused, { ownerPid: process.pid, ownerStart: "not-this-process" }));
    expect(applyTransactionStatus(reused)).toMatchObject({ ownerAlive: false });
    expect(recoverApplyTransaction(reused, manifest(reused)).next).toEqual(["monocarve", "apply", "--plan", ".plans/p-test.json", "--commit"]);

    const noProcfs: ProcessProbe = { signal: () => "exists", startIdentity: () => null };
    expect(ownerLiveness(process.pid, "anything", noProcfs)).toBe("uncertain");
    expect(ownerLiveness(4242, "anything", { signal: () => "unknown", startIdentity: () => "x" })).toBe("uncertain");
    expect(ownerLiveness(4242, "anything", { signal: () => "missing", startIdentity: () => null })).toBe("dead");
    const uncertain = repo();
    writeTransaction(uncertain, staleState(uncertain, { ownerPid: process.pid, ownerStart: "anything" }));
    expect(() => recoverApplyTransaction(uncertain, manifest(uncertain), { probe: noProcfs })).toThrow("cannot be proven stopped");
    expect(applyTransactionStatus(uncertain, noProcfs)).toMatchObject({ ownerAlive: true });
  });

  test("a new transaction records its own start identity", () => {
    const root = repo();
    const active = beginApplyTransaction(root, manifest(root), ".plans/p-test.json");
    expect(active.state.ownerStart).toBe(procStartIdentity(process.pid) ?? undefined);
    expect(applyTransactionStatus(root)).toMatchObject({ ownerAlive: true });
    active.complete();
    active.release();
  });
});

describe("evidence lock without procfs", () => {
  const noProcfs: LockProcessProbe = { startIdentity: () => null, signal: () => "exists" };

  test("refuses to acquire when this process's start identity cannot be recorded", () => {
    const root = scratchDirectory();
    mkdirSync(join(root, "src"));
    const paths = publicationPaths(root, "evidence", ["src"]);
    expect(() => acquireLock(paths, noProcfs)).toThrow("EVIDENCE_DESTINATION_UNSAFE");
    expect(existsSync(paths.lock)).toBeFalse();
  });

  test("a held lock whose owner cannot be verified is busy, never broken", () => {
    const root = scratchDirectory();
    mkdirSync(join(root, "src"));
    const paths = publicationPaths(root, "evidence", ["src"]);
    mkdirSync(paths.lock);
    const owner = `${JSON.stringify({ schemaVersion: 1, pid: process.ppid, processStart: "recorded" })}\n`;
    writeFileSync(join(paths.lock, "owner.json"), owner);
    // This process can record itself, but the owner's /proc entry is unreadable.
    const probe: LockProcessProbe = { startIdentity: (pid) => (pid === process.pid ? "self" : null), signal: () => "exists" };
    expect(() => acquireLock(paths, probe)).toThrow("cannot be proven stale");
    expect(() => acquireLock(paths, probe)).toThrow("EVIDENCE_DESTINATION_BUSY");
    expect(readFileSync(join(paths.lock, "owner.json"), "utf8")).toBe(owner);
    // A provably missing owner is still reported for recovery, not silently taken over.
    expect(() => acquireLock(paths, { ...probe, signal: () => "missing" })).toThrow("EVIDENCE_RECOVERY_REQUIRED");
    expect(readFileSync(join(paths.lock, "owner.json"), "utf8")).toBe(owner);
  });
});
