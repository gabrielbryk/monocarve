import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { publishEvidence, validateBundle, type EvidenceManifestBase } from "../src/assessment/evidence.ts";
import { scratchDirectory } from "./support/fixture-repo.ts";

test("evidence publication validates integrity and replaces generated files byte-identically", () => {
  const root = scratchDirectory();
  const publish = (replace = false) => publishEvidence<EvidenceManifestBase>({
    rootDir: root, destination: "evidence", analyticalRoots: ["src"], artifacts: { "raw/app.json": "{}\n", "summary.json": "{\"ok\":true}\n" },
    requiredArtifacts: new Set(["raw/app.json"]), manifest: () => ({ kind: "architecture-assessment" }), ...(replace ? { replaceGenerated: true } : {}),
  });
  const first = publish();
  validateBundle(join(root, "evidence"), first.manifest);
  const before = readFileSync(join(root, "evidence/manifest.json"), "utf8");
  publish(true);
  expect(readFileSync(join(root, "evidence/manifest.json"), "utf8")).toBe(before);
});

test("evidence publication rejects unsafe paths, unrelated contents, busy writers, and insufficient budgets", () => {
  const root = scratchDirectory();
  const base = { rootDir: root, analyticalRoots: ["src"], artifacts: { "summary.json": "1234567890\n" }, requiredArtifacts: new Set(["summary.json"]), manifest: () => ({ kind: "architecture-assessment" as const }) };
  expect(() => publishEvidence({ ...base, destination: "../escape" })).toThrow("EVIDENCE_DESTINATION_UNSAFE");
  expect(() => publishEvidence({ ...base, destination: "src/evidence" })).toThrow("EVIDENCE_DESTINATION_UNSAFE");
  mkdirSync(join(root, "busy.lock"));
  expect(() => publishEvidence({ ...base, destination: "busy" })).toThrow("EVIDENCE_DESTINATION_BUSY");
  expect(() => publishEvidence({ ...base, destination: "budget", maxBytes: 1 })).toThrow("required evidence alone exceeds the budget");
  publishEvidence({ ...base, destination: "owned" });
  writeFileSync(join(root, "owned/unrelated.txt"), "mine\n");
  expect(() => publishEvidence({ ...base, destination: "owned", replaceGenerated: true })).toThrow("unrelated paths");
});

test("caught replacement failure restores the prior bundle at every phase", () => {
  const root = scratchDirectory();
  const publish = (contents: string, extra: Partial<Parameters<typeof publishEvidence<EvidenceManifestBase>>[0]> = {}) => publishEvidence<EvidenceManifestBase>({
    rootDir: root, destination: "evidence", analyticalRoots: ["src"], artifacts: { "summary.json": contents }, requiredArtifacts: new Set(["summary.json"]), manifest: () => ({ kind: "architecture-assessment" }), ...extra,
  });
  publish("old\n");
  expect(() => publish("new\n", { replaceGenerated: true, failAfter: "prior-preserved" })).toThrow("injected evidence failure");
  expect(readFileSync(join(root, "evidence/summary.json"), "utf8")).toBe("old\n");
  expect(existsSync(join(root, "evidence.recovery.json"))).toBeFalse();
  expect(() => publish("new\n", { replaceGenerated: true, failAfter: "published" })).toThrow("injected evidence failure");
  expect(readFileSync(join(root, "evidence/summary.json"), "utf8")).toBe("old\n");
  expect(existsSync(join(root, "evidence.recovery.json"))).toBeFalse();
  expect(existsSync(join(root, "evidence.backup"))).toBeFalse();
});
