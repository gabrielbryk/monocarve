import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publishEvidence, type EvidenceManifestBase, type PublishEvidenceOptions } from "../src/assessment/evidence.ts";
import { scratchDirectory } from "./support/fixture-repo.ts";

function options(rootDir: string, contents: string): PublishEvidenceOptions<EvidenceManifestBase> {
  return { rootDir, destination: "evidence", analyticalRoots: ["src"], artifacts: { "raw/app.json": "raw\n", "summary.json": contents }, requiredArtifacts: new Set(["raw/app.json", "summary.json"]), manifest: () => ({ kind: "architecture-assessment" }) };
}
function publishPrior(root: string): void { publishEvidence(options(root, "old summary\n")); }
function snapshot(path: string): unknown {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (stat.isDirectory()) return readdirSync(path).sort().map((name) => [name, snapshot(join(path, name))]);
  return { mode: stat.mode, bytes: readFileSync(path).toString("base64") };
}

test("quarantine cleanup refuses raced foreign replacements and preserves unexpected quarantine children", () => {
  for (const race of ["replacement", "quarantine-child"] as const) {
    const root = scratchDirectory();
    publishPrior(root);
    const backup = join(root, "evidence.backup");
    const quarantine = `${backup}.quarantine`;
    expect(() => publishEvidence({
      ...options(root, "new\n"), replaceGenerated: true,
      testPhaseHook: (phase) => {
        if (phase !== "cleanup-quarantined") return;
        if (race === "replacement") {
          mkdirSync(backup);
          writeFileSync(join(backup, "foreign.txt"), "foreign replacement\n");
        } else {
          writeFileSync(join(quarantine, "foreign.txt"), "foreign quarantine child\n");
        }
      },
    })).toThrow(race === "replacement" ? "path was replaced during quarantine cleanup" : "unexpected paths");
    if (race === "replacement") expect(readFileSync(join(backup, "foreign.txt"), "utf8")).toBe("foreign replacement\n");
    else expect(readFileSync(join(quarantine, "foreign.txt"), "utf8")).toBe("foreign quarantine child\n");
    expect(existsSync(quarantine)).toBeTrue();
    const residueBeforeRetry = snapshot(root);
    expect(() => publishEvidence({ ...options(root, "retry\n"), replaceGenerated: true })).toThrow("EVIDENCE_RECOVERY_REQUIRED");
    const residueAfterRetry = snapshot(root);
    expect(residueAfterRetry).toEqual(residueBeforeRetry);
  }
});
