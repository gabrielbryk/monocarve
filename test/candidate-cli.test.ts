import { describe, expect, test } from "bun:test";

import { run, runJson } from "./support/cli.ts";

interface CandidateDetail {
  readonly id: string;
  readonly eligible: boolean;
  readonly files: readonly string[];
  readonly closure: readonly string[];
  readonly sccs: readonly { readonly id: string; readonly members: readonly string[] }[];
  readonly targetSuggestion: { readonly packageName: string; readonly packageRoot: string };
}

describe("candidate CLI", () => {
  test("documents lookup and filter flags in command help", async () => {
    const result = await run("candidates", "--help");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--candidate <id>");
    expect(result.stdout).toContain("--path <path>");
    expect(result.stdout).toContain("--eligibility <all|eligible|blocked>");
    expect(result.stdout).toContain("--equivalence-group <id>");
  });

  test("expands an equivalence group by its representative candidate id", async () => {
    const portfolio = await runJson<{ top: { id: string; equivalenceGroup: { candidateIds: string[] } }[] }>(
      "portfolio", "--recommendation", "all", "--json",
    );
    const representative = portfolio.top[0];
    if (!representative) throw new Error("fixture produced no portfolio group");
    const details = await runJson<CandidateDetail[]>("candidates", "--equivalence-group", representative.id, "--json");
    expect(details.map(({ id }) => id).sort()).toEqual([...representative.equivalenceGroup.candidateIds].sort());
  }, 240_000);

  test("filters by a claimed path and emits stable detailed JSON", async () => {
    const args = ["candidates", "--path", "apps/web/src/widgets/chart.ts", "--eligibility", "eligible", "--json"];
    const first = await run(...args);
    const second = await run(...args);
    expect(first.code).toBe(0);
    expect(first.stderr).toBe("");
    expect(second.stdout).toBe(first.stdout);

    const details = JSON.parse(first.stdout) as CandidateDetail[];
    expect(details.length).toBeGreaterThan(0);
    expect(details.every((candidate) => candidate.eligible)).toBe(true);
    expect(details.every((candidate) => candidate.closure.includes("apps/web/src/widgets/chart.ts"))).toBe(true);
    expect(details[0]?.sccs.length).toBeGreaterThan(0);
    expect(details[0]?.targetSuggestion.packageRoot).toStartWith("libs/");
  }, 240_000);

  test("looks up an exact candidate and renders a compact table", async () => {
    const [candidate] = await runJson<CandidateDetail[]>("candidates", "--path", "apps/web/src/widgets/chart.ts", "--json");
    if (!candidate) throw new Error("fixture produced no matching candidate");
    const result = await run("candidates", "--candidate", candidate.id);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("ID");
    expect(result.stdout).toContain("STATE");
    expect(result.stdout).toContain(candidate.id);
  }, 240_000);

  test("scope renders the concise review through piped stdout unless JSON is explicit", async () => {
    const human = await run(
      "scope",
      "--path", "apps/web/src/widgets/chart.ts",
      "--package-name", "@acme/chart-ui",
    );
    expect(human.code).toBe(0);
    expect(human.stderr).toBe("");
    expect(human.stdout).toStartWith("Plan c-");
    expect(human.stdout).toContain("Target: @acme/chart-ui");
    expect(human.stdout).not.toContain('"schema":"scope"');

    const machine = await run(
      "scope",
      "--path", "apps/web/src/widgets/chart.ts",
      "--package-name", "@acme/chart-ui",
      "--json",
    );
    expect(machine.code).toBe(0);
    expect((JSON.parse(machine.stdout) as { schema: string }).schema).toBe("scope");
  }, 240_000);

  test("refuses absent ids and invalid eligibility values", async () => {
    const absent = await run("candidates", "--candidate", "c-absent");
    expect(absent.code).toBe(1);
    expect(absent.stderr).toContain("CandidateLookupError: candidate not found: c-absent");

    const invalid = await run("candidates", "--eligibility", "maybe");
    expect(invalid.code).toBe(64);
    expect(invalid.stderr).toContain("--eligibility must be one of all, eligible, or blocked");
  }, 240_000);
});
