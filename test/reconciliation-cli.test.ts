import { describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseArgs } from "../src/cli.ts";
import { reconciliationCommands } from "../src/commands/reconciliation.ts";
import type { ExtractionManifest } from "../src/plan/manifest.ts";
import { readReconciliationRecord } from "../src/reconciliation/index.ts";
import { committedWorkspace, existsSync, runJsonIn } from "./support/cli.ts";
import { fixtureGit } from "./support/fixture-repo.ts";

async function invoke(root: string, command: "reconcile" | "receipt" | "reconcile-approve", ...args: string[]): Promise<Record<string, unknown>> {
  let output = "";
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await reconciliationCommands[command]!.run(parseArgs([command, "--cwd", root, "--json", ...args]));
  } finally {
    process.stdout.write = original;
  }
  return JSON.parse(output) as Record<string, unknown>;
}

async function appliedWorkspace(): Promise<{ root: string; path: string; manifest: ExtractionManifest }> {
  const root = committedWorkspace();
  // Reconciliation needs a plan with the fixture's generated-artifact path;
  // request the full mechanically eligible set rather than the new
  // architecturally-recommended default slice.
  const portfolio = await runJsonIn<{ top: { id: string }[] }>(root, "portfolio", "--recommendation", "all", "--strategy", "max-loc", "--no-cache");
  const candidate = portfolio.top[0];
  if (candidate === undefined) throw new Error("fixture has no candidate");
  const planned = await runJsonIn<{ output: string }>(
    root,
    "plan",
    "--candidate",
    candidate.id,
    "--package-name",
    "@acme/reconciled",
    "--out",
    "plans/reconciliation-source.json",
    "--write",
    "--no-cache",
  );
  await runJsonIn(root, "approve", "--plan", planned.output, "--commit");
  await runJsonIn(root, "apply", "--plan", planned.output, "--commit");
  const manifest = JSON.parse(readFileSync(join(root, planned.output), "utf8")) as ExtractionManifest;
  return { root, path: planned.output, manifest };
}

describe("reconciliation command layer", () => {
  test("requires explicit operator-owned review text before loading a workspace", async () => {
    await expect(reconciliationCommands.reconcile!.run(parseArgs(["reconcile", "--plan", "plan.json"]))).rejects.toThrow("--reason");
    await expect(reconciliationCommands.reconcile!.run(parseArgs(["reconcile", "--plan", "plan.json", "--reason", "because"]))).rejects.toThrow(
      "--approval-subject",
    );
  });

  test("previews and exclusively writes deterministic receipt and reconciliation evidence", async () => {
    const { root, path, manifest } = await appliedWorkspace();
    const appliedHead = fixtureGit(root, "rev-parse", "HEAD");
    const receipt = await invoke(root, "receipt", "--plan", path);
    expect(receipt).toMatchObject({ schema: "applied-plan-receipt-preview-v1", written: false });
    expect(receipt.output).toBe(`.monocarve/plans/${manifest.planId}.receipt.${appliedHead}.json`);

    const receiptWritten = await invoke(root, "receipt", "--plan", path, "--out", "records/receipt.json", "--write");
    expect(receiptWritten).toMatchObject({ output: "records/receipt.json", written: true });
    expect(existsSync(join(root, "records/receipt.json"))).toBe(true);
    const lifecycle = await runJsonIn<{ state: string; failures: string[] }>(root, "status", "--plan", path, "--receipt", "records/receipt.json");
    expect(lifecycle).toMatchObject({ state: "applied-and-audited", failures: [] });
    fixtureGit(root, "add", "--", "records/receipt.json");
    fixtureGit(root, "commit", "-qm", "chore: retain synthetic receipt");

    const operation = manifest.operations.find((entry) => entry.kind === "write-file" && entry.path.endsWith("tsconfig.json"));
    if (operation?.kind !== "write-file") throw new Error("fixture plan has no tsconfig write");
    const changed = join(root, operation.path);
    writeFileSync(changed, `${readFileSync(changed, "utf8")}\n`);
    fixtureGit(root, "add", "--", operation.path);
    fixtureGit(root, "commit", "-qm", "chore: regenerate synthetic config");
    const observedHead = fixtureGit(root, "rev-parse", "HEAD");
    const originalPlan = readFileSync(join(root, path), "utf8");

    const preview = await invoke(
      root,
      "reconcile",
      "--plan",
      path,
      "--reason",
      "generator retained an equivalent config",
      "--approval-subject",
      "chore: accept synthetic reconciliation",
    );
    expect(preview).toMatchObject({ schema: "reconciliation-preview-v1", written: false });
    expect(preview.output).toBe(`.monocarve/plans/${manifest.planId}.reconcile.${observedHead}.json`);
    const record = preview.record as { discrepancies: { path: string }[] };
    expect(record.discrepancies.map((entry) => entry.path)).toEqual([operation.path]);

    const written = await invoke(
      root,
      "reconcile",
      "--plan",
      path,
      "--reason",
      "generator retained an equivalent config",
      "--approval-subject",
      "chore: accept synthetic reconciliation",
      "--out",
      "records/reconciliation.json",
      "--write",
    );
    expect(written).toMatchObject({ output: "records/reconciliation.json", written: true });
    expect(readFileSync(join(root, path), "utf8")).toBe(originalPlan);
    const originalRecord = readFileSync(join(root, "records/reconciliation.json"), "utf8");
    await expect(
      invoke(
        root,
        "reconcile",
        "--plan",
        path,
        "--reason",
        "generator retained an equivalent config",
        "--approval-subject",
        "chore: accept synthetic reconciliation",
        "--out",
        "records/reconciliation.json",
        "--write",
      ),
    ).rejects.toThrow();
    expect(readFileSync(join(root, "records/reconciliation.json"), "utf8")).toBe(originalRecord);
    expect(() => readReconciliationRecord(root, "../outside.json")).toThrow("not workspace-relative");
    writeFileSync(join(root, "records/tampered.json"), `${readFileSync(join(root, "records/reconciliation.json"), "utf8")}\n`);
    expect(() => readReconciliationRecord(root, "records/tampered.json")).toThrow("not canonical");
    rmSync(join(root, "records/tampered.json"));
    const unapprovedStatus = await runJsonIn<{ state: string; failures: string[] }>(
      root,
      "status",
      "--plan",
      path,
      "--reconciliation",
      "records/reconciliation.json",
    );
    expect(unapprovedStatus.state).toBe("unknown");
    expect(unapprovedStatus.failures.join("\n")).toContain("approval");
    const approved = await invoke(root, "reconcile-approve", "--record", "records/reconciliation.json", "--commit");
    expect(approved).toMatchObject({ path: "records/reconciliation.json", committed: true });
    const reconciledReceipt = await invoke(
      root,
      "receipt",
      "--plan",
      path,
      "--reconciliation",
      "records/reconciliation.json",
      "--out",
      "records/reconciled-receipt.json",
      "--write",
    );
    expect(reconciledReceipt).toMatchObject({ schema: "applied-plan-receipt-preview-v1", written: true });
    const originalReceipt = readFileSync(join(root, "records/reconciled-receipt.json"), "utf8");
    await expect(
      invoke(root, "receipt", "--plan", path, "--reconciliation", "records/reconciliation.json", "--out", "records/reconciled-receipt.json", "--write"),
    ).rejects.toThrow();
    expect(readFileSync(join(root, "records/reconciled-receipt.json"), "utf8")).toBe(originalReceipt);

    const missingReconciliation = await runJsonIn<{ state: string; failures: string[] }>(
      root,
      "status",
      "--plan",
      path,
      "--receipt",
      "records/reconciled-receipt.json",
    );
    expect(missingReconciliation).toMatchObject({ state: "unknown" });
    expect(missingReconciliation.failures.join("\n")).toContain("reconciliation linkage");
    const reconciledLifecycle = await runJsonIn<{ state: string; failures: string[] }>(
      root,
      "status",
      "--plan",
      path,
      "--receipt",
      "records/reconciled-receipt.json",
      "--reconciliation",
      "records/reconciliation.json",
    );
    expect(reconciledLifecycle).toMatchObject({ state: "applied-and-audited", failures: [] });

    const receiptPath = join(root, "records/reconciled-receipt.json");
    const receiptValue = JSON.parse(readFileSync(receiptPath, "utf8")) as { plan: { planId: string } };
    receiptValue.plan.planId = "another-plan";
    writeFileSync(join(root, "records/tampered-receipt.json"), `${JSON.stringify(receiptValue, null, 2)}\n`);
    const tamperedStatus = await runJsonIn<{ state: string; failures: string[] }>(
      root,
      "status",
      "--plan",
      path,
      "--receipt",
      "records/tampered-receipt.json",
      "--reconciliation",
      "records/reconciliation.json",
    );
    expect(tamperedStatus.state).toBe("unknown");
    expect(tamperedStatus.failures.join("\n")).toMatch(/receipt id|plan linkage/);

    writeFileSync(changed, `${readFileSync(changed, "utf8")}further drift\n`);
    fixtureGit(root, "add", "--", operation.path);
    fixtureGit(root, "commit", "-qm", "chore: drift after reconciled receipt");
    const staleReceipt = await runJsonIn<{ state: string; failures: string[] }>(
      root,
      "status",
      "--plan",
      path,
      "--receipt",
      "records/reconciled-receipt.json",
      "--reconciliation",
      "records/reconciliation.json",
    );
    expect(staleReceipt.state).toBe("drifted");
    expect(staleReceipt.failures.length).toBeGreaterThan(0);
  }, 120_000);

  test("reconciliation approval refuses unsafe boundaries and rolls back hook tampering", async () => {
    const { root, path, manifest } = await appliedWorkspace();
    const operation = manifest.operations.find((entry) => entry.kind === "write-file" && entry.path.endsWith("tsconfig.json"));
    if (operation?.kind !== "write-file") throw new Error("fixture plan has no tsconfig write");
    writeFileSync(join(root, operation.path), `${readFileSync(join(root, operation.path), "utf8")}\n`);
    fixtureGit(root, "add", "--", operation.path);
    fixtureGit(root, "commit", "-qm", "chore: produce reviewed drift");
    const observedHead = fixtureGit(root, "rev-parse", "HEAD");
    await invoke(
      root,
      "reconcile",
      "--plan",
      path,
      "--reason",
      "reviewed generated drift",
      "--approval-subject",
      "chore: approve reviewed drift",
      "--out",
      "records/reconciliation.json",
      "--write",
    );
    const recordBytes = readFileSync(join(root, "records/reconciliation.json"), "utf8");

    writeFileSync(join(root, "unrelated.txt"), "unrelated\n");
    await expect(invoke(root, "reconcile-approve", "--record", "records/reconciliation.json", "--commit")).rejects.toThrow("requires only its unstaged record");
    rmSync(join(root, "unrelated.txt"));

    fixtureGit(root, "checkout", "-qb", "main");
    await expect(invoke(root, "reconcile-approve", "--record", "records/reconciliation.json", "--commit")).rejects.toThrow("guarded");
    fixtureGit(root, "checkout", "-q", "verify-fixture");

    fixtureGit(root, "commit", "--allow-empty", "-qm", "chore: wrong approval parent");
    await expect(invoke(root, "reconcile-approve", "--record", "records/reconciliation.json", "--commit")).rejects.toThrow("directly atop");
    fixtureGit(root, "reset", "--hard", observedHead);

    const hook = join(root, ".git/hooks/pre-commit");
    writeFileSync(hook, "#!/bin/sh\nprintf '\\n' >> records/reconciliation.json\ngit add -- records/reconciliation.json\n");
    chmodSync(hook, 0o755);
    await expect(invoke(root, "reconcile-approve", "--record", "records/reconciliation.json", "--commit")).rejects.toThrow("hook changed");
    expect(fixtureGit(root, "rev-parse", "HEAD")).toBe(observedHead);
    expect(readFileSync(join(root, "records/reconciliation.json"), "utf8")).toBe(recordBytes);
    expect(fixtureGit(root, "status", "--short")).toBe("?? records/");
  }, 120_000);

  test("status rejects reconciliation approvals with the wrong subject or commit scope", async () => {
    const { root, path, manifest } = await appliedWorkspace();
    const operation = manifest.operations.find((entry) => entry.kind === "write-file" && entry.path.endsWith("tsconfig.json"));
    if (operation?.kind !== "write-file") throw new Error("fixture plan has no tsconfig write");
    writeFileSync(join(root, operation.path), `${readFileSync(join(root, operation.path), "utf8")}\n`);
    fixtureGit(root, "add", "--", operation.path);
    fixtureGit(root, "commit", "-qm", "chore: produce scoped drift");
    const subject = "chore: approve scoped reconciliation";
    await invoke(
      root,
      "reconcile",
      "--plan",
      path,
      "--reason",
      "reviewed generated drift",
      "--approval-subject",
      subject,
      "--out",
      "records/reconciliation.json",
      "--write",
    );

    fixtureGit(root, "add", "--", "records/reconciliation.json");
    fixtureGit(root, "commit", "-qm", "chore: wrong reconciliation subject");
    const wrongSubject = await runJsonIn<{ state: string; failures: string[] }>(
      root,
      "status",
      "--plan",
      path,
      "--reconciliation",
      "records/reconciliation.json",
    );
    expect(wrongSubject).toMatchObject({ state: "unknown" });
    expect(wrongSubject.failures.join("\n")).toContain("subject");

    writeFileSync(join(root, "extra.txt"), "extra scope\n");
    fixtureGit(root, "add", "--", "extra.txt");
    fixtureGit(root, "commit", "--amend", "-qm", subject);
    const wrongScope = await runJsonIn<{ state: string; failures: string[] }>(
      root,
      "status",
      "--plan",
      path,
      "--reconciliation",
      "records/reconciliation.json",
    );
    expect(wrongScope).toMatchObject({ state: "unknown" });
    expect(wrongScope.failures.join("\n")).toContain("exactly the record path");
  }, 120_000);
});
