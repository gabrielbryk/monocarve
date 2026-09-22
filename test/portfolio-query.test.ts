import { describe, expect, test } from "bun:test";

import { parseConfig } from "../src/config.ts";
import {
  CandidateLookupError,
  formatCandidateTable,
  queryCandidates,
  serializeCandidateDetails,
  type Portfolio,
  type PortfolioCandidate,
} from "../src/portfolio/index.ts";

const config = parseConfig({
  applications: [{ name: "service", sourceRoot: "apps/service/src", tsconfig: "apps/service/tsconfig.json" }],
  packageRoots: ["packages"],
  packageScope: "@acme/",
  scaffoldTemplates: { packageJson: { contents: "{}" } },
});

function candidate(overrides: Partial<PortfolioCandidate> & Pick<PortfolioCandidate, "id">): PortfolioCandidate {
  const { id, ...rest } = overrides;
  const file = `apps/service/src/${id}.ts`;
  const seed = { id: `scc-${id}`, members: [file] };
  return {
    id,
    application: "service",
    suggestedPackageName: `@acme/${id}`,
    files: [file],
    tests: [],
    assets: [],
    sccs: [seed],
    seed,
    lineCount: 10,
    owners: ["apps/service"],
    domains: ["core"],
    dependencies: [],
    consumers: [],
    consumerChurn: 0,
    coverage: 1,
    score: 10,
    eligible: true,
    rejectionReasons: [],
    warnings: [],
    rewriteEscapes: [],
    ...rest,
  };
}

function portfolio(candidates: readonly PortfolioCandidate[]): Portfolio {
  return { rootDir: process.cwd(), candidates, selected: [] };
}

describe("candidate portfolio queries", () => {
  test("intersects directories and exact test or asset paths", () => {
    const billing = candidate({ id: "c-billing", files: ["apps/service/src/billing/model.ts"], tests: ["apps/service/test/billing.test.ts"] });
    const images = candidate({ id: "c-images", assets: ["apps/service/src/images/logo.svg"] });
    const sourceMatches = queryCandidates(portfolio([images, billing]), config, { path: "apps/service/src/billing" });
    const testMatches = queryCandidates(portfolio([images, billing]), config, { path: "apps/service/test/billing.test.ts" });
    const assetMatches = queryCandidates(portfolio([billing, images]), config, { path: "apps/service/src/images/logo.svg" });

    expect(sourceMatches.map(({ id }) => id)).toEqual(["c-billing"]);
    expect(testMatches.map(({ id }) => id)).toEqual(["c-billing"]);
    expect(assetMatches.map(({ id }) => id)).toEqual(["c-images"]);
  });

  test("filters independently by eligibility and exact id", () => {
    const ready = candidate({ id: "c-ready", eligible: true });
    const blocked = candidate({
      id: "c-blocked",
      eligible: false,
      rejectionReasons: [{ code: "unresolved-imports", detail: "cannot resolve local dependency", edges: ["x.ts -> ./missing"] }],
    });

    expect(queryCandidates(portfolio([blocked, ready]), config, { eligibility: "eligible" }).map(({ id }) => id)).toEqual(["c-ready"]);
    expect(queryCandidates(portfolio([ready, blocked]), config, { eligibility: "blocked" }).map(({ id }) => id)).toEqual(["c-blocked"]);
    expect(queryCandidates(portfolio([ready, blocked]), config, { id: "c-blocked" })[0]?.blockers[0]?.edges).toEqual(["x.ts -> ./missing"]);
  });

  test("refuses an absent exact id", () => {
    expect(() => queryCandidates(portfolio([candidate({ id: "c-present" })]), config, { id: "c-absent" })).toThrow(CandidateLookupError);
  });

  test("canonicalizes detail, JSON, and table ordering", () => {
    const alpha = candidate({ id: "c-alpha", score: 20, files: ["apps/service/src/z.ts", "apps/service/src/a.ts"], warnings: ["z warning", "a warning"] });
    const beta = candidate({ id: "c-beta", score: 20 });
    const first = queryCandidates(portfolio([beta, alpha]), config);
    const second = queryCandidates(portfolio([alpha, beta]), config);

    expect(first.map(({ id }) => id)).toEqual(["c-alpha", "c-beta"]);
    expect(first[0]?.files).toEqual(["apps/service/src/a.ts", "apps/service/src/z.ts"]);
    expect(first[0]?.targetSuggestion).toEqual({ packageName: "@acme/c-alpha", packageRoot: "packages/c-alpha" });
    expect(serializeCandidateDetails(first)).toBe(serializeCandidateDetails(second));
    expect(formatCandidateTable(first)).toBe(formatCandidateTable(second));
  });
});
