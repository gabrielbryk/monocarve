/**
 * Interrupted committing applies: a child process runs `applyPlan --commit`
 * against a throwaway fixture repository and parks after a journal operation;
 * the test then SIGKILLs or SIGINTs it and proves HEAD, the index, and every
 * worktree byte are back where the apply found them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { APPLY_LOCK_FILENAME, APPLY_STATE_FILENAME, TOOL_NAME } from "../src/branding.ts";
import type { MonocarveConfig } from "../src/config.ts";
import { manifestPaths, type ExtractionManifest } from "../src/plan/manifest.ts";
import { guardInterrupts, type InterruptRuntime } from "../src/transaction/apply-interrupt.ts";
import { applyTransactionStatus, beginApplyTransaction, recoverApplyTransaction } from "../src/transaction/apply-state.ts";
import { applyPlan } from "../src/transaction/apply.ts";
import { snapshotPaths } from "../src/transaction/journal.ts";
import { cleanupFixtures, fixtureConfig, fixtureGit, fixtureRepo, scratchDirectory } from "./support/fixture-repo.ts";
import { baseManifest, DONOR, extractionFiles, landManifest, TARGET } from "./support/transaction-fixture.ts";

afterEach(cleanupFixtures);

const REPO = resolve(import.meta.dir, "..");
const CHECKPOINT_FILENAME = `${TOOL_NAME}-apply-checkpoint.json`;

const CHILD = `
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig } from ${JSON.stringify(join(REPO, "src/config.ts"))};
import { applyPlan } from ${JSON.stringify(join(REPO, "src/transaction/apply.ts"))};

const [root, manifestPath, pauseAfter, ready] = process.argv.slice(2);
const configPath = join(root, "monocarve.config.json");
const config = parseConfig(JSON.parse(readFileSync(configPath, "utf8")), configPath);
const manifest = JSON.parse(readFileSync(join(root, manifestPath), "utf8"));
await applyPlan({
  config,
  rootDir: root,
  manifest,
  manifestPath,
  commit: true,
  testHooks: {
    afterJournalOperation: async (index) => {
      if (index !== Number(pauseAfter)) return;
      writeFileSync(ready, String(index));
      await new Promise((resolve) => setTimeout(resolve, 120_000));
    },
  },
});
`;

interface Checkout {
  readonly head: string;
  readonly index: string;
  readonly status: string;
  readonly files: Readonly<Record<string, string>>;
}

function checkout(root: string): Checkout {
  const files: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.name === ".git") continue;
      if (entry.isDirectory()) walk(absolute);
      else files[relative(root, absolute)] = `${(statSync(absolute).mode & 0o777).toString(8)}:${readFileSync(absolute).toString("base64")}`;
    }
  };
  walk(root);
  return {
    head: fixtureGit(root, "rev-parse", "HEAD"),
    index: fixtureGit(root, "write-tree"),
    status: fixtureGit(root, "status", "--porcelain", "--untracked-files=all"),
    files,
  };
}

interface Prepared {
  readonly root: string;
  readonly config: MonocarveConfig;
  readonly manifest: ExtractionManifest;
  readonly manifestPath: string;
  readonly before: Checkout;
}

function prepare(): Prepared {
  const root = fixtureRepo(extractionFiles());
  const config = fixtureConfig(root);
  const manifest = baseManifest(root);
  const manifestPath = landManifest(root, manifest);
  return { root, config, manifest, manifestPath, before: checkout(root) };
}

/** Start the child and wait until it is parked mid-journal (after operation `pauseAfter`). */
async function parkedChild({ root, manifestPath }: Prepared, pauseAfter = 1): Promise<Bun.Subprocess<"ignore", "pipe", "pipe">> {
  const scratch = scratchDirectory();
  const script = join(scratch, "apply-child.ts");
  const ready = join(scratch, "ready");
  writeFileSync(script, CHILD);
  const child = Bun.spawn(["bun", script, root, manifestPath, String(pauseAfter), ready], {
    cwd: scratch,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ALLOW_GIT_WORKTREE_ADD: "1" },
  });
  const deadline = Date.now() + 90_000;
  // Polling is inherently sequential.
  while (!existsSync(ready)) {
    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`child never parked (exit ${child.exitCode}): ${await new Response(child.stderr).text()}`);
    }
    await Bun.sleep(50);
  }
  return child;
}

function transactionFiles(root: string): string[] {
  return [APPLY_LOCK_FILENAME, APPLY_STATE_FILENAME, CHECKPOINT_FILENAME].filter((name) => existsSync(join(root, ".git", name)));
}

describe("interrupted committing apply", () => {
  test("SIGKILL mid-journal leaves a durable checkpoint that apply-recover restores byte-identically", async () => {
    const prepared = prepare();
    const { root, manifest, manifestPath, before } = prepared;
    const child = await parkedChild(prepared);

    // Genuinely half-mutated: the donor has moved but the journal is unfinished.
    expect(existsSync(join(root, DONOR))).toBeFalse();
    expect(existsSync(join(root, TARGET))).toBeTrue();
    child.kill("SIGKILL");
    await child.exited;

    expect(transactionFiles(root)).toEqual([APPLY_LOCK_FILENAME, APPLY_STATE_FILENAME, CHECKPOINT_FILENAME]);
    expect(applyTransactionStatus(root)).toMatchObject({ active: true, ownerAlive: false, checkpointed: true, state: { phase: "applying" } });
    const refusal: unknown = await applyPlan({ config: prepared.config, rootDir: root, manifest, manifestPath, commit: true }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(Error);
    expect(String(refusal)).toContain("apply-recover");

    const recovered = recoverApplyTransaction(root, manifest);
    expect(recovered.restored).toMatchObject({ headCommit: before.head, indexTree: before.index });
    expect(recovered.next).toEqual([TOOL_NAME, "apply", "--plan", manifestPath, "--commit"]);
    expect(checkout(root)).toEqual(before);
    expect(transactionFiles(root)).toEqual([]);

    // The printed next step now succeeds instead of refusing a dirty tree.
    const reapplied = await applyPlan({ config: prepared.config, rootDir: root, manifest, manifestPath, commit: true });
    expect(reapplied.ok).toBeTrue();
    expect(fixtureGit(root, "log", "-1", "--format=%s")).toBe(manifest.commits.wiring.subject);
  }, 180_000);

  test("SIGINT mid-journal rolls back in-process, releases the lock, and exits 130", async () => {
    const prepared = prepare();
    const { root, before } = prepared;
    const child = await parkedChild(prepared);
    expect(existsSync(join(root, DONOR))).toBeFalse();

    child.kill("SIGINT");
    const code = await child.exited;
    const stderr = await new Response(child.stderr).text();

    expect(code).toBe(130);
    expect(stderr).toContain("apply interrupted by SIGINT; rolled back");
    expect(transactionFiles(root)).toEqual([]);
    expect(applyTransactionStatus(root)).toEqual({ active: false, ownerAlive: false });
    expect(checkout(root)).toEqual(before);
  }, 180_000);

  test("--force-corrupt-lock still restores the checkpoint after the lock and state are corrupted", async () => {
    const prepared = prepare();
    const { root, manifest, before } = prepared;
    const child = await parkedChild(prepared, 2);
    child.kill("SIGKILL");
    await child.exited;
    writeFileSync(join(root, ".git", APPLY_LOCK_FILENAME), "\u0000torn");
    writeFileSync(join(root, ".git", APPLY_STATE_FILENAME), "{");

    expect(() => recoverApplyTransaction(root, manifest)).toThrow("--force-corrupt-lock");
    const recovered = recoverApplyTransaction(root, manifest, { forceCorruptLock: true });
    expect(recovered.restored).toMatchObject({ headCommit: before.head });
    expect(recovered.quarantined).toHaveLength(2);
    expect(transactionFiles(root)).toEqual([]);
    expect(checkout(root)).toEqual(before);
  }, 180_000);
});

/**
 * In-process twin of an apply whose restore failed: checkpoint, phase
 * `applying`, the journal's first move landed, then the owner releases
 * without completing — what apply.ts and the interrupt guard do on residue.
 */
function abandonMidJournal({ root, manifest, manifestPath }: Prepared): void {
  const indexTree = fixtureGit(root, "write-tree");
  const transaction = beginApplyTransaction(root, manifest, manifestPath);
  transaction.checkpoint({
    headCommit: fixtureGit(root, "rev-parse", "HEAD"),
    branch: fixtureGit(root, "rev-parse", "--abbrev-ref", "HEAD"),
    snapshots: snapshotPaths(root, manifestPaths(manifest)),
    staged: true,
    indexTree,
  });
  transaction.update("applying");
  mkdirSync(dirname(join(root, TARGET)), { recursive: true });
  fixtureGit(root, "mv", "--", DONOR, TARGET);
  transaction.release();
}

async function applyRefusal(prepared: Prepared, resume: boolean): Promise<unknown> {
  const { root, config, manifest, manifestPath } = prepared;
  return applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true, ...(resume ? { resume: true } : {}) }).then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("unrecovered transaction after a failed restore", () => {
  test("keeps its lock, so neither apply --commit nor --resume can orphan the checkpoint; apply-recover restores it", async () => {
    const prepared = prepare();
    const { root, manifest, manifestPath, before } = prepared;
    abandonMidJournal(prepared);
    const checkpoint = readFileSync(join(root, ".git", CHECKPOINT_FILENAME), "utf8");

    const expectRefusedAndUntouched = (refusal: unknown): void => {
      expect(refusal).toBeInstanceOf(Error);
      expect(String(refusal)).toContain("awaits recovery");
      expect(String(refusal)).toContain("apply-recover");
      expect(transactionFiles(root)).toEqual([APPLY_LOCK_FILENAME, APPLY_STATE_FILENAME, CHECKPOINT_FILENAME]);
      expect(readFileSync(join(root, ".git", CHECKPOINT_FILENAME), "utf8")).toBe(checkpoint);
    };
    expectRefusedAndUntouched(await applyRefusal(prepared, false));
    expectRefusedAndUntouched(await applyRefusal(prepared, true));
    expect(applyTransactionStatus(root)).toMatchObject({
      active: true,
      ownerAlive: false,
      checkpointed: true,
      state: { phase: "applying", released: true },
      next: [TOOL_NAME, "apply-recover", "--plan", manifestPath],
    });

    const recovered = recoverApplyTransaction(root, manifest);
    expect(recovered.restored).toMatchObject({ headCommit: before.head, indexTree: before.index });
    expect(recovered.restored?.discarded).toBeUndefined();
    expect(checkout(root)).toEqual(before);
    expect(transactionFiles(root)).toEqual([]);
    expect(applyTransactionStatus(root)).toEqual({ active: false, ownerAlive: false });
  });

  test("state or checkpoint left without a lock blocks a new apply and stays recoverable", () => {
    const prepared = prepare();
    const { root, manifest, manifestPath, before } = prepared;
    abandonMidJournal(prepared);
    unlinkSync(join(root, ".git", APPLY_LOCK_FILENAME));
    expect(() => beginApplyTransaction(root, manifest, manifestPath)).toThrow("never recovered");
    unlinkSync(join(root, ".git", APPLY_STATE_FILENAME));
    expect(() => beginApplyTransaction(root, manifest, manifestPath)).toThrow("unrecovered transaction");
    expect(transactionFiles(root)).toEqual([CHECKPOINT_FILENAME]);
    expect(applyTransactionStatus(root)).toMatchObject({ active: true, checkpointed: true, orphanedCheckpoint: join(root, ".git", CHECKPOINT_FILENAME) });

    expect(() => recoverApplyTransaction(root, { ...manifest, planId: "other-plan" })).toThrow("belongs to plan");
    const recovered = recoverApplyTransaction(root, manifest);
    expect(recovered.restored).toMatchObject({ headCommit: before.head, indexTree: before.index });
    expect(checkout(root)).toEqual(before);
    expect(transactionFiles(root)).toEqual([]);
  });
});

function editAfterInterruption(root: string): void {
  writeFileSync(join(root, TARGET), "export const widgetValue = 42; // developer edit\n");
  writeFileSync(join(root, "NOTES.md"), "unrelated staged work\n");
  fixtureGit(root, "add", "--", "NOTES.md");
}

describe("apply-recover over changes made after the interruption", () => {
  test("refuses by default and names every changed or staged path", () => {
    const prepared = prepare();
    const { root, manifest } = prepared;
    abandonMidJournal(prepared);
    editAfterInterruption(root);

    const refusal = (() => {
      try {
        recoverApplyTransaction(root, manifest);
        return "";
      } catch (error) {
        return String(error);
      }
    })();
    expect(refusal).toContain("changed after it stopped");
    expect(refusal).toContain(`${TARGET} (working tree)`);
    expect(refusal).toContain("NOTES.md (staged)");
    expect(refusal).toContain("--discard-changes");
    expect(refusal).not.toContain(DONOR);
    expect(readFileSync(join(root, TARGET), "utf8")).toContain("developer edit");
    expect(fixtureGit(root, "diff", "--cached", "--name-only")).toContain("NOTES.md");
    expect(transactionFiles(root)).toEqual([APPLY_LOCK_FILENAME, APPLY_STATE_FILENAME, CHECKPOINT_FILENAME]);
  });

  test("--discard-changes restores over them and reports what was discarded", () => {
    const prepared = prepare();
    const { root, manifest, before } = prepared;
    abandonMidJournal(prepared);
    editAfterInterruption(root);

    const recovered = recoverApplyTransaction(root, manifest, { discardChanges: true });
    expect(recovered.restored?.discarded).toEqual([`${TARGET} (working tree)`, "NOTES.md (staged)"]);
    const after = checkout(root);
    expect(after.head).toBe(before.head);
    expect(after.index).toBe(before.index);
    expect(after.files[DONOR]).toBe(before.files[DONOR]);
    expect(existsSync(join(root, TARGET))).toBeFalse();
    expect(transactionFiles(root)).toEqual([]);
  });
});

function fakeRuntime(): InterruptRuntime & { fire(signal: "SIGINT" | "SIGTERM"): void; reports: string[]; codes: number[] } {
  const listeners = new Map<string, () => void>();
  const reports: string[] = [];
  const codes: number[] = [];
  return {
    reports,
    codes,
    on: (signal, listener) => listeners.set(signal, listener),
    off: (signal) => listeners.delete(signal),
    exit: (code) => codes.push(code),
    report: (text) => reports.push(text),
    fire: (signal) => listeners.get(signal)?.(),
  };
}

describe("interrupt outside the mutating window", () => {
  test("before the checkpoint nothing was mutated: the lock is released with an accurate message", () => {
    const { root, manifest, manifestPath } = prepare();
    const runtime = fakeRuntime();
    guardInterrupts(root, beginApplyTransaction(root, manifest, manifestPath), runtime);
    runtime.fire("SIGTERM");
    expect(runtime.reports.join("")).toContain("no checkout mutation had started; lock released");
    expect(runtime.codes).toEqual([143]);
    expect(transactionFiles(root)).toEqual([]);
  });

  test("an unarmed interrupt past the simulating phase keeps the transaction for apply-recover", () => {
    const { root, manifest, manifestPath } = prepare();
    const runtime = fakeRuntime();
    const transaction = beginApplyTransaction(root, manifest, manifestPath);
    guardInterrupts(root, transaction, runtime);
    transaction.update("move-committed");
    runtime.fire("SIGINT");
    expect(runtime.reports.join("")).toContain("transaction kept; run monocarve apply-status, then monocarve apply-recover");
    expect(transactionFiles(root)).toEqual([APPLY_LOCK_FILENAME, APPLY_STATE_FILENAME]);
    expect(applyTransactionStatus(root)).toMatchObject({ active: true, ownerAlive: false, state: { released: true } });
  });
});
