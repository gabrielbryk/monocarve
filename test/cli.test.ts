/** End-to-end command families against the synthetic workspace. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { statusShort } from "../src/util/git.ts";
import { registerCliTailTests } from "./support/cli-tail.ts";
import { FIXTURE, PLAN_DIR, committedWorkspace, existsSync, readFileSync, run, runJson, runJsonIn, writeFileSync } from "./support/cli.ts";
import { cleanupFixtures } from "./support/fixture-repo.ts";

interface CandidateSummary {
  readonly id: string;
  readonly application: string;
  readonly files: readonly string[];
  readonly tests: readonly string[];
  readonly assets: readonly string[];
  readonly eligible: boolean;
  readonly suggestedPackageName: string;
  readonly warnings: readonly string[];
}

interface PortfolioReport {
  readonly totals: { readonly candidates: number; readonly eligible: number; readonly blocked: number };
  readonly limit: number;
  readonly truncated: boolean;
  readonly top: CandidateSummary[];
  readonly selected: string[];
}

let candidate: CandidateSummary;
let candidates: CandidateSummary[] = [];
let planPath = "";

describe("cli pipeline", () => {
  beforeAll(async () => {
    const portfolio = await runJson<PortfolioReport>("portfolio", "--recommendation", "all", "--strategy", "max-loc");
    candidates = portfolio.top;
    const chart = portfolio.top.find((entry) => entry.assets.length > 0);
    if (!chart) throw new Error("fixture portfolio produced no candidate with assets");
    candidate = chart;
  }, 120_000);

  afterAll(() => {
    rmSync(PLAN_DIR, { recursive: true, force: true });
    cleanupFixtures();
  });

  test("scan reports a stable dependency model", async () => {
    const first = await runJson<{ moduleCount: number; digest: string; byZone: Record<string, number> }>("scan");
    const second = await runJson<{ digest: string }>("scan");
    expect(first.moduleCount).toBeGreaterThan(0);
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.byZone.application).toBeGreaterThan(0);
    expect(second.digest).toBe(first.digest);
  }, 120_000);

  test("portfolio captures the widget closure, totals, and evaluation warning", async () => {
    expect(candidate.application).toBe("web");
    expect(candidate.eligible).toBe(true);
    expect(candidate.files).toContain("apps/web/src/widgets/chart.ts");
    expect(candidate.files).toContain("apps/web/src/types.ts");
    expect(candidate.tests).toEqual(["apps/web/src/widgets/chart.test.ts"]);
    expect(candidate.assets).toEqual(["apps/web/src/widgets/chart.css"]);
    const full = await runJson<PortfolioReport>("portfolio");
    const sliced = await runJson<PortfolioReport>("portfolio", "--limit", "1");
    expect(full.totals.candidates).toBe(full.totals.eligible + full.totals.blocked);
    expect(sliced.totals).toEqual(full.totals);
    expect(sliced.top).toEqual([full.top[0]!]);
    expect(sliced.truncated).toBe(true);
    const evaluating = candidate.warnings.filter((warning) => warning.includes("do work when evaluated"));
    expect(evaluating).toHaveLength(1);
    expect(evaluating[0]).toContain("2 of 4 module(s)");
    expect(candidates.some((entry) => entry.id !== candidate.id && entry.warnings.some((warning) => warning.includes("1 of 3 module(s)")))).toBe(true);
  }, 180_000);

  test("plan compilation is byte-deterministic and captures all operation kinds", async () => {
    const compile = (out: string) =>
      runJson<Record<string, unknown>>("plan", "--candidate", candidate.id, "--package-name", "@acme/chart", "--write", "--out", out);
    const first = await compile(".monocarve/determinism-first.json");
    await compile(".monocarve/determinism-second.json");
    const firstBytes = await Bun.file(join(PLAN_DIR, "determinism-first.json")).text();
    const secondBytes = await Bun.file(join(PLAN_DIR, "determinism-second.json")).text();
    expect(secondBytes).toBe(firstBytes);
    const manifest = first as unknown as {
      target: { packageName: string; packageRoot: string; profile: unknown };
      source: { assets: string[] };
      dependencies: { runtime: Record<string, string>; packageReferences: string[] };
      dependencyDecisions: { name: string; decision: string; sources: string[]; reasons: string[] }[];
      projectedArtifacts: { path: string; resultHash: string }[];
      operations: { kind: string; path?: string; packageRoot?: string; mode?: string }[];
      consumers: { file: string }[];
      gates: { project: string[] };
    };
    expect(manifest.target).toMatchObject({ packageName: "@acme/chart", packageRoot: "libs/chart" });
    expect(first).toMatchObject({ targetMode: "new", targetPackageRoot: "libs/chart" });
    expect(first).toMatchObject({
      approval: {
        manifestPath: ".monocarve/determinism-first.json",
        subject: expect.any(String),
        gitAdd: ["git", "add", "--", ".monocarve/determinism-first.json"],
        approve: ["monocarve", "approve", "--plan", ".monocarve/determinism-first.json", "--commit"],
        apply: ["monocarve", "apply", "--plan", ".monocarve/determinism-first.json", "--commit"],
      },
    });
    expect(manifest.source.assets).toEqual(["apps/web/src/widgets/chart.css"]);
    expect(manifest.dependencies.runtime["@acme/format"]).toBe("workspace:*");
    expect(manifest.dependencies.packageReferences).toEqual(["libs/format"]);
    expect(manifest.dependencyDecisions).toContainEqual(
      expect.objectContaining({ name: "@acme/format", decision: "target-runtime", reasons: ["production-import"] }),
    );
    expect(manifest.projectedArtifacts.some(({ path, resultHash }) => path === "pnpm-lock.yaml" && /^[0-9a-f]{64}$/.test(resultHash))).toBeTrue();
    const kinds = new Set(manifest.operations.map((operation) => operation.kind));
    expect(["move", "rewrite-import", "write-file", "lockfile-importer"].every((kind) => kinds.has(kind))).toBe(true);
    expect(manifest.operations.find((operation) => operation.kind === "lockfile-importer" && operation.packageRoot === "libs/chart")?.mode).toBe("insert");
    expect(manifest.consumers.map((consumer) => consumer.file)).toContain("apps/web/src/main.ts");
    expect(manifest.gates.project).toEqual(["test -d apps/web", "test web = web"]);
  }, 180_000);

  test("plan and next classify an existing target from the baseline inventory", async () => {
    const planned = await runJson<{ targetMode: string; targetPackageRoot: string }>("plan", "--candidate", candidate.id, "--package-name", "@acme/format");
    const selected = await runJson<{ targetMode: string; targetPackageRoot: string }>("next", "--package-name", "@acme/format");
    expect(planned).toMatchObject({ targetMode: "existing", targetPackageRoot: "libs/format" });
    expect(selected).toMatchObject({ targetMode: "existing", targetPackageRoot: "libs/format" });
  }, 180_000);

  test("plan can require a real package-manager lockfile round-trip before writing", async () => {
    const planned = await runJsonIn<{ written: boolean; lockfileVerification: { ok: boolean; command: string } }>(
      committedWorkspace(),
      "plan",
      "--candidate",
      candidate.id,
      "--package-name",
      "@acme/chart",
      "--verify-lockfile",
    );
    expect(planned.written).toBeFalse();
    expect(planned.lockfileVerification).toMatchObject({ ok: true, command: expect.stringContaining("pnpm") });
  }, 300_000);

  test("apply simulates rather than changing the invoked checkout", async () => {
    const written = await runJson<{ output: string }>("plan", "--candidate", candidate.id, "--package-name", "@acme/chart", "--write");
    planPath = written.output;
    const result = await runJson<{ ok: boolean; planId: string; rolledBack: boolean; failure?: string }>("apply", "--plan", planPath);
    expect(result).toMatchObject({ ok: true, planId: expect.any(String), rolledBack: false });
    expect(existsSync(join(FIXTURE, "apps/web/src/widgets/chart.ts"))).toBe(true);
    expect(existsSync(join(FIXTURE, "libs/chart"))).toBe(false);
  }, 300_000);

  test("doctor replays gates and refuses gate bypasses", async () => {
    const statusBefore = statusShort(FIXTURE);
    const report = await runJson<{ schema: string; manifest: string; validation: { ok: boolean }; simulation: { ok: boolean; gates: { command: string }[] } }>(
      "doctor",
      "--plan",
      planPath,
    );
    expect(report.schema).toBe("doctor");
    expect(report.manifest).toBe(planPath);
    expect(report.validation.ok).toBe(true);
    expect(report.simulation.ok).toBe(true);
    expect(report.simulation.gates.map((gate) => gate.command)).toContain("sh scripts/check-module-ledger.sh");
    const refused = await run("doctor", "--plan", planPath, "--skip-gates");
    expect(refused.code).toBe(64);
    expect(refused.stderr).toContain("doctor always runs the manifest's gates");
    expect(statusShort(FIXTURE)).toBe(statusBefore);
  }, 300_000);

  test("doctor reports a configured manifest-gate failure without applying", async () => {
    const brokenPath = ".monocarve/doctor-failing-gate.json";
    const broken = JSON.parse(readFileSync(join(FIXTURE, planPath), "utf8")) as { gates: { workspace: string[] } };
    broken.gates.workspace = ["printf 'apps/web/src/Broken.ts:7:3 lint error\\n' >&2; false"];
    writeFileSync(join(FIXTURE, brokenPath), `${JSON.stringify(broken, null, 2)}\n`);
    const result = await run("doctor", "--plan", brokenPath);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as { simulation: { ok: boolean; failure?: string } };
    expect(report.simulation.ok).toBe(false);
    expect(report.simulation.failure).toContain("gate failed (workspace): printf");
    expect(report.simulation.failure).toContain("apps/web/src/Broken.ts:7:3 lint error");
    expect(existsSync(join(FIXTURE, "apps/web/src/widgets/chart.ts"))).toBe(true);
  }, 300_000);

  test("apply refuses to bypass its simulation proof", async () => {
    const result = await run("apply", "--plan", planPath, "--skip-simulation");
    expect(result.code).toBe(64);
    expect(result.stderr).toContain("apply always runs simulation first");
  }, 120_000);

  registerCliTailTests({ candidate: () => candidate, planPath: () => planPath });
});
