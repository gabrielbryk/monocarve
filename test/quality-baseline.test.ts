import { describe, expect, test } from "bun:test";
import { judge } from "../scripts/quality/baseline.ts";
import type { BaselinedFinding, QualityBaseline } from "../scripts/quality/baseline.ts";

describe("judge", () => {
  test("finding absent from baseline lands in failures", () => {
    const findings: BaselinedFinding[] = [
      { path: "src/index.ts", metric: "maxLines", actual: 250, detail: "maxLines 250 > 200" },
    ];
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
    const findings: BaselinedFinding[] = [
      { path: "src/app.ts", metric: "maxCyclo", actual: 16, detail: "maxCyclo 16 > 15" },
    ];
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
    const findings: BaselinedFinding[] = [
      { path: "src/utils.ts", metric: "maxLines", actual: 180, detail: "maxLines 180 < 200" },
    ];
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
    const findings: BaselinedFinding[] = [
      { path: "src/core.ts", metric: "maxCyclo", actual: 15, detail: "maxCyclo 15" },
    ];
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
    const baseline: QualityBaseline = {
      "src/old.ts": { maxLines: 300, maxCyclo: 20 },
    };

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
    const baseline: QualityBaseline = {
      "src/mixed.ts": { maxLines: 200, maxCyclo: 15 },
    };

    const verdict = judge(findings, baseline);

    expect(verdict.improved).toHaveLength(1);
    expect(verdict.improved[0]?.finding.metric).toBe("maxLines");
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0]?.finding.metric).toBe("maxCyclo");
    expect(verdict.accepted).toHaveLength(0);
    expect(verdict.stale).toHaveLength(0);
  });
});
