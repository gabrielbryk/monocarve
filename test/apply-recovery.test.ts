/**
 * Interrupted committing applies: a child process runs `applyPlan --commit`
 * against a throwaway fixture repository and parks after a journal operation;
 * the test then SIGKILLs or SIGINTs it and proves HEAD, the index, and every
 * worktree byte are back where the apply found them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { APPLY_LOCK_FILENAME, APPLY_STATE_FILENAME, TOOL_NAME } from "../src/branding.ts";
import type { MonocarveConfig } from "../src/config.ts";
import type { ExtractionManifest } from "../src/plan/manifest.ts";
import { applyTransactionStatus, recoverApplyTransaction } from "../src/transaction/apply-state.ts";
import { applyPlan } from "../src/transaction/apply.ts";
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
