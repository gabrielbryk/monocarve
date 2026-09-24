import { expect, test } from "bun:test";
import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { FIXTURE, committedWorkspace, configureAllowedDirtyPaths, readFileSync, run, runIn, runJson, runJsonIn, writeFileSync } from "./cli.ts";
import { fixtureGit } from "./fixture-repo.ts";

interface CandidateSummary {
  readonly id: string;
  readonly files: readonly string[];
  readonly suggestedPackageName: string;
}

interface PortfolioReport {
  readonly totals: { readonly candidates: number; readonly eligible: number; readonly blocked: number };
  readonly top: CandidateSummary[];
}

export function registerCliTailTests(input: {
  readonly candidate: () => CandidateSummary;
  readonly planPath: () => string;
  readonly workspace: () => string;
}): void {
  test("audit refuses a plan that has not been applied", async () => {
    // This plan was compiled and applied against the throwaway `workspace`
    // (see cli.test.ts), not `FIXTURE` — audit must be pointed at the same
    // checkout the plan's paths and baseline commit actually belong to.
    const result = await runIn(input.workspace(), "audit", "--plan", input.planPath());
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as { passed: boolean; byteFidelity: { failures: string[] } };
    expect(report.passed).toBe(false);
    expect(report.byteFidelity.failures.some((failure) => failure.includes("moved source still present"))).toBe(true);
  }, 120_000);

  test("verify validates the plan and names the preflight blocker the tree earns", async () => {
    const workspace = committedWorkspace();
    const portfolio = await runJsonIn<PortfolioReport>(workspace, "portfolio", "--recommendation", "all");
    const target = portfolio.top.find((entry) => entry.files.includes("apps/web/src/widgets/chart.ts"));
    expect(target).toBeDefined();
    const written = await runJsonIn<{ output: string }>(workspace, "plan", "--candidate", target!.id, "--package-name", "@acme/chart", "--write");
    const verify = async (planPath = written.output) => {
      const result = await runIn(workspace, "verify", "--plan", planPath);
      return { ...result, report: JSON.parse(result.stdout) as { validation: { ok: boolean }; blockers: string[] } };
    };
    const clean = await verify();
    expect(clean.report.validation.ok).toBe(true);
    expect(clean.report.blockers).toEqual([]);
    expect(clean.code).toBe(0);
    const manifest = JSON.parse(readFileSync(join(workspace, written.output), "utf8")) as { commits: { plan?: { subject: string } } };
    fixtureGit(workspace, "add", "-f", "--", written.output);
    fixtureGit(workspace, "commit", "-qm", manifest.commits.plan!.subject);
    const committedManifest = await verify(`./${written.output}`);
    expect(committedManifest.report.validation.ok).toBe(true);
    expect(committedManifest.report.blockers).toEqual([]);
    writeFileSync(join(workspace, "README.md"), "Edited, uncommitted, and therefore a blocker.\n");
    const dirty = await verify();
    expect(dirty.report.blockers).toEqual(["working tree is not clean: README.md"]);
    expect(dirty.code).toBe(1);
  }, 300_000);

  test("applying tolerates the unrelated dirt the repository declared, and nothing else", async () => {
    const workspace = committedWorkspace();
    writeFileSync(join(workspace, "agent-state.json"), "{}\n");
    fixtureGit(workspace, "add", "--", "agent-state.json");
    fixtureGit(workspace, "commit", "-qm", "test: add agent state");
    configureAllowedDirtyPaths(workspace, ["agent-state.json"]);
    const portfolio = await runJsonIn<PortfolioReport>(workspace, "portfolio");
    const target = portfolio.top[0]!;
    const written = await runJsonIn<{ output: string }>(workspace, "plan", "--candidate", target.id, "--package-name", "@acme/allowed", "--write");
    const manifest = JSON.parse(readFileSync(join(workspace, written.output), "utf8")) as { commits: { plan?: { subject: string } } };
    fixtureGit(workspace, "add", "-f", "--", written.output);
    fixtureGit(workspace, "commit", "-qm", manifest.commits.plan!.subject);
    writeFileSync(join(workspace, "agent-state.json"), '{"rewritten":true}\n');
    const allowed = JSON.parse((await runIn(workspace, "verify", "--plan", `./${written.output}`)).stdout) as { blockers: string[] };
    expect(allowed.blockers).toEqual([]);
    writeFileSync(join(workspace, "CHANGELOG.md"), "Undeclared dirt.\n");
    const blocked = JSON.parse((await runIn(workspace, "verify", "--plan", `./${written.output}`)).stdout) as { blockers: string[] };
    expect(blocked.blockers).toEqual(["working tree is not clean: CHANGELOG.md"]);
  }, 300_000);

  test("backlog explains every blocked candidate with a concrete edge", async () => {
    const backlog = await runJson<{
      totals: PortfolioReport["totals"];
      limit: number;
      truncated: boolean;
      top: { blocking: { code: string }[]; unblock: string[] }[];
    }>("backlog");
    expect(backlog.top.length).toBeGreaterThan(0);
    expect(backlog.top.every((entry) => entry.blocking.length > 0 && entry.unblock.length > 0)).toBe(true);
    expect(backlog.top.some((entry) => entry.blocking.some((reason) => reason.code === "composition-root"))).toBe(true);
    expect(backlog.totals.blocked).toBe(backlog.top.length);
    const sliced = await runJson<typeof backlog>("backlog", "--limit", "1");
    expect(sliced.totals).toEqual(backlog.totals);
    expect(sliced.top).toHaveLength(1);
    expect(sliced.truncated).toBe(true);
  }, 180_000);

  test("backlog --marginal reports its conservative one-blocker schema", async () => {
    const ordinary = await runJson<Record<string, unknown>>("backlog");
    const marginal = await runJson<{ schema: string; scope: string; top: { occurrences: number; freedCandidates: number }[] }>("backlog", "--marginal");
    expect(ordinary.schema).toBe("backlog");
    expect(ordinary).not.toHaveProperty("scope");
    expect(marginal.schema).toBe("backlog-marginal");
    expect(marginal.scope).toContain("one-change lower bound");
    expect(marginal.top.every((blocker) => blocker.occurrences >= blocker.freedCandidates)).toBe(true);
  }, 180_000);

  test("next picks the highest-scoring candidate and can plan it unattended", async () => {
    const portfolio = await runJson<PortfolioReport>("portfolio");
    if (!portfolio.top[0]) throw new Error("fixture has no architecturally recommended candidate");
    const next = await runJson<{ candidate: string; packageName: string; written: boolean }>("next");
    expect(next.candidate).toBe(portfolio.top[0].id);
    expect(next.packageName).toBe(input.candidate().suggestedPackageName);
    expect(next.written).toBe(false);
  }, 180_000);

  test("check import-extensions passes and reports a violation", async () => {
    expect((await run("check", "import-extensions")).code).toBe(0);
    const offender = join(FIXTURE, "libs/format/src/offender.ts");
    await Bun.write(offender, 'export * from "./number";\n');
    try {
      const dirty = await run("check", "import-extensions", "--json");
      expect(dirty.code).toBe(1);
      const report = JSON.parse(dirty.stdout) as { violations: { file: string; line: number; specifier: string }[] };
      expect(report.violations).toContainEqual({ file: "libs/format/src/offender.ts", line: 1, specifier: "./number" });
    } finally {
      rmSync(offender, { force: true });
    }
  }, 120_000);

  test("portfolio --communities is a deterministic read-only diagnostic", async () => {
    const ordinary = await runJson<PortfolioReport>("portfolio");
    const first = await runJson<{ schema: string; graphDigest: string; parameters: { algorithm: string }; communities: { members: string[] }[] }>(
      "portfolio",
      "--communities",
    );
    const second = await runJson<typeof first>("portfolio", "--communities");
    expect(first.schema).toBe("portfolio-communities");
    expect(first.parameters.algorithm).toBe("deterministic-louvain-local-move");
    expect(first.graphDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.communities.flatMap((entry) => entry.members)).toContain("apps/web/src/widgets/chart.ts");
    expect(second).toEqual(first);
    expect(await runJson<PortfolioReport>("portfolio")).toEqual(ordinary);
  }, 120_000);

  test("allows configured unrelated dirt but refuses unconfigured and plan-overlapping paths", async () => {
    const workspace = committedWorkspace();
    const target = (await runJsonIn<PortfolioReport>(workspace, "portfolio")).top[0]!;
    expect((await runIn(workspace, "plan", "--candidate", target.id)).code).toBe(0);
    configureAllowedDirtyPaths(workspace, ["README.md", "apps/web/src", "scratch"]);
    writeFileSync(join(workspace, "README.md"), "Edited, uncommitted but unrelated.\n");
    fixtureGit(workspace, "add", "--", "README.md");
    expect((await runIn(workspace, "plan", "--candidate", target.id)).code).toBe(0);
    const aliased = await runIn(workspace, "plan", "--candidate", target.id, "--out", "scratch/../README.md", "--write");
    expect(aliased.code).toBe(1);
    expect(aliased.stderr).toContain("README.md");
    symlinkSync(".", join(workspace, "scratch"), "dir");
    const symlinked = await runIn(workspace, "plan", "--candidate", target.id, "--out", "scratch/README.md", "--write");
    expect(symlinked.code).toBe(1);
    writeFileSync(join(workspace, "CHANGELOG.md"), "Unconfigured dirt.\n");
    const dirty = await runIn(workspace, "plan", "--candidate", target.id);
    expect(dirty.code).toBe(1);
    expect(dirty.stderr).toContain("CHANGELOG.md");
    expect(dirty.stderr).not.toContain("usage:");
    fixtureGit(workspace, "clean", "-f", "--", "CHANGELOG.md");
    writeFileSync(join(workspace, target.files[0]!), "export const changed = true;\n");
    const overlap = await runIn(workspace, "plan", "--candidate", target.id);
    expect(overlap.code).toBe(1);
    expect(overlap.stderr).toContain(target.files[0]!);
  }, 300_000);

  test("checks both endpoints of a dirty rename against allowDirtyPaths", async () => {
    const check = async (allowed: string, expected: string) => {
      const workspace = committedWorkspace();
      writeFileSync(join(workspace, "notes.md"), "baseline note\n");
      fixtureGit(workspace, "add", "--", "notes.md");
      fixtureGit(workspace, "commit", "-qm", "test: add note");
      configureAllowedDirtyPaths(workspace, [allowed]);
      const target = (await runJsonIn<PortfolioReport>(workspace, "portfolio")).top[0]!;
      fixtureGit(workspace, "mv", "notes.md", "renamed-note.md");
      const result = await runIn(workspace, "plan", "--candidate", target.id);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(expected);
    };
    await check("notes.md", "renamed-note.md");
    await check("renamed-note.md", "notes.md");
  }, 300_000);

  test("audit reports a schema mismatch instead of crashing", async () => {
    const written = await runJson<{ output: string }>(
      "plan",
      "--candidate",
      input.candidate().id,
      "--package-name",
      "@acme/chart",
      "--write",
      "--out",
      ".monocarve/legacy-source.json",
    );
    const legacy = JSON.parse(readFileSync(join(FIXTURE, written.output), "utf8")) as Record<string, unknown>;
    legacy.schemaVersion = 0;
    delete legacy.application;
    const legacyPath = ".monocarve/legacy-schema.json";
    writeFileSync(join(FIXTURE, legacyPath), `${JSON.stringify(legacy, null, 2)}\n`);
    const audited = await run("audit", "--plan", legacyPath);
    expect(audited.code).toBe(1);
    const report = JSON.parse(audited.stdout) as {
      passed: boolean;
      failures: string[];
      unauditable?: string[];
      byteFidelity: { passed: boolean; checked: number; failures: string[] };
    };
    expect(report.passed).toBe(false);
    expect(report.failures).toEqual(["[schema-version] manifest schemaVersion must be 2, 3, or 4"]);
    expect(report.unauditable).toEqual(report.failures);
    expect(report.byteFidelity).toEqual({ passed: false, checked: 0, failures: [] });
    const verified = await runIn(FIXTURE, "verify", "--plan", legacyPath);
    const validation = (JSON.parse(verified.stdout) as { validation: { issues: { rule: string; message: string }[] } }).validation;
    expect(validation.issues.map((issue) => `[${issue.rule}] ${issue.message}`)).toEqual(report.failures);
  }, 300_000);

  test("unknown commands and missing arguments fail loudly", async () => {
    expect((await run("nope")).code).toBe(64);
    const missing = await run("plan");
    expect(missing.code).toBe(64);
    expect(missing.stderr).toContain("--candidate");
    expect(missing.stderr).toContain("usage:");
  }, 60_000);
}
