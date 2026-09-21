import { describe, expect, test } from "bun:test";

import type { ExtractionManifest } from "../src/plan/manifest.ts";
import {
  assertAppliedPlanReceiptValid,
  assertReconciliationRecordValid,
  compileAppliedPlanReceipt,
  compileReconciliationRecord,
  reconciliationRecordId,
  serializeAppliedPlanReceipt,
  serializeReconciliationRecord,
} from "../src/reconciliation/index.ts";
import type { AuditReport } from "../src/transaction/audit.ts";
import { hashText } from "../src/util/hash.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const BASELINE = "1".repeat(40);
const APPROVAL = "2".repeat(40);
const MOVE = "3".repeat(40);
const WIRING = "4".repeat(40);
const LATER = "5".repeat(40);

function manifest(): ExtractionManifest {
  return {
    schemaVersion: 2,
    planId: "synthetic-plan",
    createdAt: "2026-01-01T00:00:00.000Z",
    generator: { name: "synthetic-tool", version: "1.0.0" },
    baselineCommit: BASELINE,
    graphDigest: HASH_A,
    application: "synthetic-app",
    target: { packageName: "@acme/unit", packageRoot: "packages/unit", entrypoint: "src/index.ts", requiredExports: [] },
    source: { files: ["apps/example/src/unit.ts"], tests: [], sccs: {} },
    dependencies: { runtime: {}, dev: {}, packageReferences: [] },
    sourceBlobs: { "apps/example/src/unit.ts": HASH_A },
    operations: [
      { kind: "move", source: "apps/example/src/unit.ts", target: "packages/unit/src/unit.ts", preconditionHash: HASH_A, resultHash: HASH_A },
      { kind: "write-file", path: "packages/unit/tsconfig.json", contents: "{}\n", preconditionHash: "missing", resultHash: HASH_A },
    ],
    consumers: [],
    generatedFiles: [{
      path: "packages/unit/tsconfig.json", source: "config", regenerate: "synthetic-generator",
      regenerateOnApply: true, expectedHash: HASH_A,
    }],
    changedFiles: ["apps/example/src/unit.ts", "packages/unit/src/unit.ts", "packages/unit/tsconfig.json"],
    expectedDynamicImportDelta: { added: [], removed: [] },
    evaluationEffects: [],
    metrics: { movedFiles: 1, movedLines: 1, applicationLinesBefore: 1, applicationLinesAfter: 0, consumers: 0 },
    commits: {
      plan: { subject: "chore: approve synthetic plan" },
      move: { subject: "refactor: move synthetic unit" },
      wiring: { subject: "refactor: wire synthetic unit" },
    },
    gates: { package: [], project: [], workspace: [] },
  };
}

function proof(passed = true) { return { passed, checked: 1, failures: passed ? [] : ["synthetic failure"] }; }

function audit(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    planId: "synthetic-plan", baselineCommit: BASELINE, auditedRoot: "/synthetic", passed: false,
    byteFidelity: proof(false), consumerCompleteness: proof(), boundaryRules: proof(), externalConsumerCompile: proof(),
    codemodReplay: proof(), entrypointClosure: proof(), lockfileIntegrity: proof(), generatedArtifacts: proof(false),
    sourceConservation: { ...proof(), plannedFiles: 1, plannedTests: 0, plannedAssets: 0, landedFiles: 1, landedTests: 0, landedAssets: 0 },
    boundaryBaseline: { recorded: 0, observed: [], cleared: [] },
    graphEvidence: { dynamicImportDelta: { added: [], removed: [] }, movedPathEdges: [], passed: true },
    failures: ["synthetic byte drift"],
    ...overrides,
  };
}

function record(auditedRoot = "/synthetic") {
  const value = manifest();
  return compileReconciliationRecord({
    manifest: value, manifestBytes: `${JSON.stringify(value)}\n`, manifestPath: "plans/synthetic.json",
    approvalCommit: APPROVAL, moveCommit: MOVE, wiringCommit: WIRING,
    observedHead: LATER, observedCommitDate: "2026-02-03T04:05:06-06:00", audit: audit({ auditedRoot }),
    discrepancies: [{ path: "packages/unit/tsconfig.json", actual: HASH_B }],
    reason: "generator produced the reviewed solution reference set", approval: { subject: "chore: accept synthetic reconciliation" },
  });
}

describe("immutable reconciliation evidence", () => {
  test("compiles deterministic linked evidence and gives generated ownership precedence", () => {
    const first = record();
    const second = record();
    expect(serializeReconciliationRecord(first)).toBe(serializeReconciliationRecord(second));
    expect(first.createdAt).toBe("2026-02-03T10:05:06.000Z");
    expect(first.plan.digest).toBe(hashText(`${JSON.stringify(manifest())}\n`));
    expect(first.discrepancies).toEqual([{
      path: "packages/unit/tsconfig.json", ownership: "generated-artifact", expected: HASH_A, actual: HASH_B, operationIndexes: [1],
    }]);
    expect(serializeReconciliationRecord(record("/another/checkout"))).toBe(serializeReconciliationRecord(first));
  });

  test("refuses undeclared drift and structural failures", () => {
    expect(() => compileReconciliationRecord({
      manifest: manifest(), manifestBytes: JSON.stringify(manifest()), manifestPath: "plans/synthetic.json", approvalCommit: APPROVAL,
      moveCommit: MOVE, wiringCommit: WIRING, observedHead: LATER, observedCommitDate: "2026-01-01T00:00:00Z",
      audit: audit(), discrepancies: [{ path: "undeclared.txt", actual: HASH_B }], reason: "reason", approval: { subject: "approval" },
    })).toThrow("undeclared discrepancy");
    expect(() => compileReconciliationRecord({
      manifest: manifest(), manifestBytes: JSON.stringify(manifest()), manifestPath: "plans/synthetic.json", approvalCommit: APPROVAL,
      moveCommit: MOVE, wiringCommit: WIRING, observedHead: LATER, observedCommitDate: "2026-01-01T00:00:00Z",
      audit: audit({ boundaryRules: proof(false) }), discrepancies: [{ path: "packages/unit/tsconfig.json", actual: HASH_B }],
      reason: "reason", approval: { subject: "approval" },
    })).toThrow("structural or semantic");
    expect(() => compileReconciliationRecord({
      manifest: manifest(), manifestBytes: JSON.stringify(manifest()), manifestPath: "plans/synthetic.json", approvalCommit: APPROVAL,
      moveCommit: MOVE, wiringCommit: WIRING, observedHead: LATER, observedCommitDate: "2026-01-01T00:00:00Z",
      audit: audit({ passed: true, byteFidelity: proof(), generatedArtifacts: proof(), failures: [] }),
      discrepancies: [{ path: "packages/unit/tsconfig.json", actual: HASH_B }], reason: "reason", approval: { subject: "approval" },
    })).toThrow("requires a failed byte-fidelity");
  });

  test("record identity detects changed evidence and non-discrepancies", () => {
    const valid = record();
    expect(() => assertReconciliationRecordValid({ ...valid, reason: "rewritten after review" })).toThrow("id does not match");
    expect(() => compileReconciliationRecord({
      manifest: manifest(), manifestBytes: JSON.stringify(manifest()), manifestPath: "plans/synthetic.json", approvalCommit: APPROVAL,
      moveCommit: MOVE, wiringCommit: WIRING, observedHead: LATER, observedCommitDate: "2026-01-01T00:00:00Z", audit: audit(),
      discrepancies: [{ path: "packages/unit/tsconfig.json", actual: HASH_A }], reason: "reason", approval: { subject: "approval" },
    })).toThrow("matches its declared state");
    expect(() => compileReconciliationRecord({
      manifest: manifest(), manifestBytes: JSON.stringify({ ...manifest(), planId: "different-plan" }),
      manifestPath: "plans/synthetic.json", approvalCommit: APPROVAL, moveCommit: MOVE, wiringCommit: WIRING,
      observedHead: LATER, observedCommitDate: "2026-01-01T00:00:00Z", audit: audit(),
      discrepancies: [{ path: "packages/unit/tsconfig.json", actual: HASH_B }], reason: "reason", approval: { subject: "approval" },
    })).toThrow("do not encode the supplied plan");
  });

  test("supports wiring-only applications but refuses evidence with no application commit", () => {
    const valid = record();
    const { moveCommit: _move, ...wiringOnlyApplication } = valid.application;
    const { recordId: _recordId, ...payload } = valid;
    const wiringOnlyPayload = { ...payload, application: wiringOnlyApplication };
    expect(() => assertReconciliationRecordValid({ ...wiringOnlyPayload, recordId: reconciliationRecordId(wiringOnlyPayload) })).not.toThrow();
    const noCommitPayload = { ...payload, application: { resultingCommit: WIRING } };
    expect(() => assertReconciliationRecordValid({ ...noCommitPayload, recordId: reconciliationRecordId(noCommitPayload) })).toThrow("move or wiring commit");
  });

  test("issues deterministic receipts only for passing identity-matched audits", () => {
    const reconciliation = record();
    const passing = audit({ passed: true, byteFidelity: proof(), generatedArtifacts: proof(), failures: [] });
    const input = {
      record: { path: "plans/reconciliation.json", bytes: serializeReconciliationRecord(reconciliation), value: reconciliation, approvalCommit: "6".repeat(40) },
      plan: reconciliation.plan, application: reconciliation.application, observedCommit: LATER,
      observedCommitDate: "2026-02-03T10:05:06Z", audit: passing, manifest: manifest(),
    };
    const receipt = compileAppliedPlanReceipt(input);
    expect(serializeAppliedPlanReceipt(receipt)).toBe(serializeAppliedPlanReceipt(compileAppliedPlanReceipt(input)));
    expect(serializeAppliedPlanReceipt(compileAppliedPlanReceipt({ ...input, audit: { ...passing, auditedRoot: "/another/checkout" } }))).toBe(serializeAppliedPlanReceipt(receipt));
    expect(receipt.reconciliation?.recordId).toBe(reconciliation.recordId);
    expect(() => assertAppliedPlanReceiptValid({ ...receipt, audit: { ...receipt.audit, digest: HASH_B } })).toThrow("id does not match");
    const { record: _record, ...withoutRecord } = input;
    expect(() => compileAppliedPlanReceipt({ ...withoutRecord, audit: passing })).toThrow("later audit commit requires");
    expect(() => compileAppliedPlanReceipt({ ...input, audit: audit() })).toThrow("failed audit");
    expect(() => compileAppliedPlanReceipt({
      ...input, record: { ...input.record, bytes: JSON.stringify({ ...reconciliation, reason: "tampered bytes" }) },
    })).toThrow("do not encode the supplied record");
    const changedProvenance = {
      ...manifest(), schemaVersion: 3 as const,
      provenance: {
        configDigest: HASH_A, policyDigest: HASH_A, compiler: { artifactIntegrity: HASH_B },
        adapters: { packageManager: { id: "synthetic", contractVersion: 1 }, taskRunner: { id: "synthetic", contractVersion: 1 } },
      },
    };
    expect(() => compileAppliedPlanReceipt({ ...input, manifest: changedProvenance })).toThrow("provenance does not match");
  });
});
