import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judge, readBaseline, summarizeBaselineUpdate, validateBaseline } from "../scripts/quality/baseline.ts";
import type { BaselinedFinding, QualityBaseline } from "../scripts/quality/baseline.ts";

describe("judge", () => {
  test("finding absent from baseline lands in failures", () => {
    const findings: BaselinedFinding[] = [{ path: "src/index.ts", metric: "maxLines", actual: 250, detail: "maxLines 250 > 200" }];
    const baseline: QualityBaseline = {};

    const verdict = judge(findings, baseline);

    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0]?.finding.path).toBe("src/index.ts");
    expect(verdict.failures[0]?.reason).toBe("not in the reviewed baseline");
    expect(verdict.accepted).toHaveLength(0);
    expect(verdict.improved).toHaveLength(0);
    expect(verdict.stale).toHaveLength(0);
  });

  test("finding whose actual exceeds recorded value lands in failures", () => {
    const findings: BaselinedFinding[] = [{ path: "src/app.ts", metric: "maxCyclo", actual: 16, detail: "maxCyclo 16 > 15" }];
    const baseline: QualityBaseline = { "src/app.ts": { maxCyclo: 14 } };

    const verdict = judge(findings, baseline);

    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0]?.finding.path).toBe("src/app.ts");
    expect(verdict.failures[0]?.reason).toBe("worse than the reviewed baseline (14)");
    expect(verdict.accepted).toHaveLength(0);
    expect(verdict.improved).toHaveLength(0);
    expect(verdict.stale).toHaveLength(0);
  });

  test("finding whose actual is below recorded value lands in improved", () => {
    const findings: BaselinedFinding[] = [{ path: "src/utils.ts", metric: "maxLines", actual: 180, detail: "maxLines 180 < 200" }];
    const baseline: QualityBaseline = { "src/utils.ts": { maxLines: 200 } };

    const verdict = judge(findings, baseline);

    expect(verdict.improved).toHaveLength(1);
    expect(verdict.improved[0]?.finding.path).toBe("src/utils.ts");
    expect(verdict.improved[0]?.recorded).toBe(200);
    expect(verdict.failures).toHaveLength(0);
    expect(verdict.accepted).toHaveLength(0);
    expect(verdict.stale).toHaveLength(0);
  });

  test("finding whose actual equals recorded value lands in accepted", () => {
    const findings: BaselinedFinding[] = [{ path: "src/core.ts", metric: "maxCyclo", actual: 15, detail: "maxCyclo 15" }];
    const baseline: QualityBaseline = { "src/core.ts": { maxCyclo: 15 } };

    const verdict = judge(findings, baseline);

    expect(verdict.accepted).toHaveLength(1);
    expect(verdict.accepted[0]?.path).toBe("src/core.ts");
    expect(verdict.failures).toHaveLength(0);
    expect(verdict.improved).toHaveLength(0);
    expect(verdict.stale).toHaveLength(0);
  });

  test("baseline entry with no corresponding finding lands in stale", () => {
    const findings: BaselinedFinding[] = [];
    const baseline: QualityBaseline = { "src/old.ts": { maxLines: 300, maxCyclo: 20 } };

    const verdict = judge(findings, baseline);

    expect(verdict.stale).toHaveLength(2);
    expect(verdict.stale).toContainEqual({ path: "src/old.ts", metric: "maxCyclo", recorded: 20 });
    expect(verdict.stale).toContainEqual({ path: "src/old.ts", metric: "maxLines", recorded: 300 });
    expect(verdict.failures).toHaveLength(0);
    expect(verdict.accepted).toHaveLength(0);
    expect(verdict.improved).toHaveLength(0);
  });

  test("empty baseline puts every finding in failures", () => {
    const findings: BaselinedFinding[] = [
      { path: "src/a.ts", metric: "maxLines", actual: 250, detail: "maxLines 250" },
      { path: "src/b.ts", metric: "maxCyclo", actual: 18, detail: "maxCyclo 18" },
    ];
    const baseline: QualityBaseline = {};

    const verdict = judge(findings, baseline);

    expect(verdict.failures).toHaveLength(2);
    expect(verdict.accepted).toHaveLength(0);
    expect(verdict.improved).toHaveLength(0);
    expect(verdict.stale).toHaveLength(0);
  });

  test("two metrics on the same path are judged independently", () => {
    const findings: BaselinedFinding[] = [
      { path: "src/mixed.ts", metric: "maxLines", actual: 180, detail: "maxLines 180" },
      { path: "src/mixed.ts", metric: "maxCyclo", actual: 18, detail: "maxCyclo 18" },
    ];
    const baseline: QualityBaseline = { "src/mixed.ts": { maxLines: 200, maxCyclo: 15 } };

    const verdict = judge(findings, baseline);

    expect(verdict.improved).toHaveLength(1);
    expect(verdict.improved[0]?.finding.metric).toBe("maxLines");
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0]?.finding.metric).toBe("maxCyclo");
    expect(verdict.accepted).toHaveLength(0);
    expect(verdict.stale).toHaveLength(0);
  });
});

describe("summarizeBaselineUpdate", () => {
  test("an unbaselined finding is listed in newEntries", () => {
    const findings: BaselinedFinding[] = [{ path: "src/new.ts", metric: "maxLines", actual: 250, detail: "maxLines 250 > 200" }];
    const baseline: QualityBaseline = {};

    const summary = summarizeBaselineUpdate(findings, baseline);

    expect(summary.newEntries).toHaveLength(1);
    expect(summary.newEntries[0]?.path).toBe("src/new.ts");
    expect(summary.newEntries[0]?.detail).toBe("maxLines 250 > 200");
    expect(summary.worsened).toHaveLength(0);
    expect(summary.improvedCount).toBe(0);
    expect(summary.staleCount).toBe(0);
  });

  test("a finding worse than its recorded value is listed in worsened with both values", () => {
    const findings: BaselinedFinding[] = [{ path: "src/app.ts", metric: "maxCyclo", actual: 18, detail: "maxCyclo 18 > 15" }];
    const baseline: QualityBaseline = { "src/app.ts": { maxCyclo: 14 } };

    const summary = summarizeBaselineUpdate(findings, baseline);

    expect(summary.newEntries).toHaveLength(0);
    expect(summary.worsened).toHaveLength(1);
    expect(summary.worsened[0]?.recorded).toBe(14);
    expect(summary.worsened[0]?.finding.actual).toBe(18);
    expect(summary.worsened[0]?.finding.path).toBe("src/app.ts");
    expect(summary.improvedCount).toBe(0);
    expect(summary.staleCount).toBe(0);
  });

  test("an improved finding is counted but not listed", () => {
    const findings: BaselinedFinding[] = [{ path: "src/utils.ts", metric: "maxLines", actual: 180, detail: "maxLines 180 < 200" }];
    const baseline: QualityBaseline = { "src/utils.ts": { maxLines: 200 } };

    const summary = summarizeBaselineUpdate(findings, baseline);

    expect(summary.improvedCount).toBe(1);
    expect(summary.newEntries).toHaveLength(0);
    expect(summary.worsened).toHaveLength(0);
    expect(summary.staleCount).toBe(0);
  });

  test("a stale baseline entry with no matching finding is counted but not listed", () => {
    const findings: BaselinedFinding[] = [];
    const baseline: QualityBaseline = { "src/gone.ts": { maxLines: 300 } };

    const summary = summarizeBaselineUpdate(findings, baseline);

    expect(summary.staleCount).toBe(1);
    expect(summary.newEntries).toHaveLength(0);
    expect(summary.worsened).toHaveLength(0);
    expect(summary.improvedCount).toBe(0);
  });

  test("an unchanged (accepted) finding produces an empty summary", () => {
    const findings: BaselinedFinding[] = [{ path: "src/core.ts", metric: "maxCyclo", actual: 15, detail: "maxCyclo 15" }];
    const baseline: QualityBaseline = { "src/core.ts": { maxCyclo: 15 } };

    const summary = summarizeBaselineUpdate(findings, baseline);

    expect(summary.newEntries).toHaveLength(0);
    expect(summary.worsened).toHaveLength(0);
    expect(summary.improvedCount).toBe(0);
    expect(summary.staleCount).toBe(0);
  });

  test("a mix of new, worsened, improved, and stale is sorted into the right buckets", () => {
    const findings: BaselinedFinding[] = [
      { path: "src/new.ts", metric: "maxLines", actual: 220, detail: "maxLines 220 > 200" },
      { path: "src/worse.ts", metric: "maxCyclo", actual: 20, detail: "maxCyclo 20 > 15" },
      { path: "src/better.ts", metric: "maxLines", actual: 100, detail: "maxLines 100" },
      { path: "src/same.ts", metric: "maxCyclo", actual: 10, detail: "maxCyclo 10" },
    ];
    const baseline: QualityBaseline = {
      "src/worse.ts": { maxCyclo: 16 },
      "src/better.ts": { maxLines: 150 },
      "src/same.ts": { maxCyclo: 10 },
      "src/stale.ts": { maxLines: 999 },
    };

    const summary = summarizeBaselineUpdate(findings, baseline);

    expect(summary.newEntries.map((f) => f.path)).toEqual(["src/new.ts"]);
    expect(summary.worsened).toHaveLength(1);
    expect(summary.worsened[0]?.finding.path).toBe("src/worse.ts");
    expect(summary.worsened[0]?.recorded).toBe(16);
    expect(summary.improvedCount).toBe(1);
    expect(summary.staleCount).toBe(1);
  });
});

describe("readBaseline", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function baselineFile(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), "quality-baseline-test-"));
    dirs.push(dir);
    const file = join(dir, "baseline.json");
    writeFileSync(file, contents);
    return file;
  }

  test("absent baseline file yields the fail-closed empty baseline", () => {
    const dir = mkdtempSync(join(tmpdir(), "quality-baseline-test-"));
    dirs.push(dir);
    const file = join(dir, "does-not-exist.json");

    expect(readBaseline(file)).toEqual({});
  });

  test("unparseable baseline file yields the fail-closed empty baseline", () => {
    const file = baselineFile("{ this is not valid json");

    expect(readBaseline(file)).toEqual({});
  });

  test("non-numeric string value is rejected with path, metric, and value in the message", () => {
    const file = baselineFile(JSON.stringify({ "src/index.ts": { maxLines: "invalid" } }));

    expect(() => readBaseline(file)).toThrow(/src\/index\.ts.*maxLines.*"invalid"/);
  });

  test("NaN value is rejected", () => {
    // JSON has no literal for NaN, so a real baseline file can never contain
    // one — this exercises the shared validation directly, the same path
    // `readBaseline` calls after a successful parse.
    const baseline = { "src/app.ts": { maxCyclo: Number.NaN } };

    expect(() => validateBaseline(baseline, "src/app.ts")).toThrow(/src\/app\.ts.*maxCyclo/);
  });

  test("Infinity value is rejected", () => {
    // `1e400` is valid JSON syntax that overflows to Infinity once parsed,
    // so this exercises the real file -> readBaseline path.
    const file = baselineFile('{ "src/app.ts": { "maxCyclo": 1e400 } }');

    expect(() => readBaseline(file)).toThrow(/src\/app\.ts.*maxCyclo/);
  });

  test("non-object metric container is rejected", () => {
    const file = baselineFile(JSON.stringify({ "src/index.ts": 250 }));

    expect(() => readBaseline(file)).toThrow(/src\/index\.ts/);
  });

  test("non-object top-level value is rejected", () => {
    const file = baselineFile(JSON.stringify([1, 2, 3]));

    expect(() => readBaseline(file)).toThrow(/top-level object/);
  });
});
