/**
 * `firstPartyPackages`: a first-party package that lives at an exact
 * workspace root, distinct from a `packageRoots` container (which holds one
 * package per subdirectory) and from `firstPartyRoots` (which has no package
 * identity at all). This proves a candidate that imports such a package by
 * its declared name scans, is eligible, plans, and applies clean — with the
 * declared name inferred as a `workspace:*` dependency.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, parseConfig } from "../src/config.ts";
import { buildDependencyGraph } from "../src/graph/build.ts";
import { scanDependencyGraph } from "../src/graph/cruiser.ts";
import { buildPortfolio } from "../src/portfolio/rank.ts";
import { buildPlanSync, serializeManifest } from "../src/plan/build.ts";
import { applyPlan } from "../src/transaction/apply.ts";
import { auditPlanSync } from "../src/transaction/audit.ts";
import { boundaryBaselineDigest } from "../src/plan/boundary-baseline.ts";
import { cleanupFixtures, fixtureGit, fixtureRepo, scratchDirectory, write } from "./support/fixture-repo.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "../fixtures/basic-monorepo");

const DONOR = "apps/web/src/widgets/chart.ts";
const SHARED_PACKAGE_JSON = `${JSON.stringify(
  {
    name: "@acme/shared",
    version: "0.0.0",
    private: true,
    type: "module",
    main: "./index.ts",
    types: "./index.ts",
  },
  null,
  2,
)}\n`;
const SHARED_INDEX = 'export const SHARED_LABEL = "shared";\n';
const EMPTY_BASELINE_DIGEST = boundaryBaselineDigest([]);

const CHART_WITH_SHARED_IMPORT = `import { formatNumber } from "@acme/format";
import { SHARED_LABEL } from "@acme/shared";

import type { Point, Series } from "../types.ts";
import "./chart.css";

export function renderChart(series: Series): string {
  const points = series.map(toLabel).join(" ");
  return \`<div class="chart" data-label="\${SHARED_LABEL}">\${points}</div>\`;
}

function toLabel(point: Point): string {
  return \`\${formatNumber(point.x)}:\${formatNumber(point.y)}\`;
}
`;

function standaloneWorkspace(): string {
  const root = join(scratchDirectory(), "workspace");
  cpSync(FIXTURE, root, { recursive: true });
  rmSync(join(root, ".monocarve"), { recursive: true, force: true });
  fixtureGit(root, "init", "-q", "-b", "work");
  fixtureGit(root, "config", "user.email", "fixture@example.invalid");
  fixtureGit(root, "config", "user.name", "Monocarve Fixture");
  fixtureGit(root, "config", "commit.gpgsign", "false");
  fixtureGit(root, "add", "-A");
  fixtureGit(root, "commit", "-qm", "test: seed workspace");
  return root;
}

describe("firstPartyPackages", () => {
  afterAll(cleanupFixtures);

  test("infers a workspace dependency on an exact-root first-party package and applies clean", async () => {
    const root = standaloneWorkspace();

    const raw = JSON.parse(readFileSync(join(root, "monocarve.config.json"), "utf8")) as {
      firstPartyPackages?: unknown;
    };
    raw.firstPartyPackages = [{ root: "shared", name: "@acme/shared" }];
    write(root, "monocarve.config.json", `${JSON.stringify(raw, null, 2)}\n`);

    // `shared` is a real, on-disk package the package manager must also see:
    // monocarve's `firstPartyPackages` config declares the *code* boundary,
    // not workspace membership, which pnpm still resolves from its own manifest.
    const workspaceManifest = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
    write(root, "pnpm-workspace.yaml", `${workspaceManifest.trimEnd()}\n  - shared\n`);
    write(root, "shared/package.json", SHARED_PACKAGE_JSON);
    write(root, "shared/index.ts", SHARED_INDEX);
    write(root, DONOR, CHART_WITH_SHARED_IMPORT);
    fixtureGit(root, "add", "-A");
    fixtureGit(root, "commit", "-qm", "test: add exact-root first-party package and a consumer");

    const { config } = await loadConfig({ cwd: root });
    expect(config.firstPartyPackages).toEqual([{ root: "shared", name: "@acme/shared" }]);

    const graph = await scanDependencyGraph({ config, rootDir: root, noCache: true });

    // Workspace inventory: the exact root's own file and owner are included
    // without being split into per-subdirectory packages the way a
    // `packageRoots` container would be.
    expect(graph.workspace.files).toContain("shared/index.ts");
    expect(graph.workspace.owners).toContain("shared");

    const portfolio = buildPortfolio({ config, graph });
    const candidate = portfolio.candidates.find((entry) => entry.eligible && entry.files.includes(DONOR));
    expect(candidate).toBeDefined();

    const manifest = buildPlanSync({
      config,
      rootDir: root,
      graph,
      candidate: candidate!,
      baselineCommit: graph.commit!,
      packageName: "@acme/chart-shared",
    });

    // Dependency inference: the declared config identity, not a package.json
    // scan of a `packageRoots` subdirectory, is what resolves the bare
    // specifier to a workspace package.
    expect(manifest.dependencies.runtime["@acme/shared"]).toBe("workspace:*");
    expect(manifest.dependencies.packageReferences).toContain("shared");

    const manifestPath = "plans/chart-shared.json";
    write(root, manifestPath, serializeManifest(manifest));
    fixtureGit(root, "add", "--", manifestPath);
    fixtureGit(root, "commit", "-qm", manifest.commits.plan!.subject);

    const result = await applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true });
    expect(result.failure).toBeUndefined();
    expect(result.ok).toBe(true);

    const packageManifest = JSON.parse(readFileSync(join(root, "libs/chart-shared/package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(packageManifest.dependencies?.["@acme/shared"]).toBe("workspace:*");

    const report = auditPlanSync({ config, rootDir: root, manifest });
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
  }, 300_000);

  test("reports a boundary violation when an exact-root package imports application code", async () => {
    const root = standaloneWorkspace();
    const raw = JSON.parse(readFileSync(join(root, "monocarve.config.json"), "utf8")) as { firstPartyPackages?: unknown };
    raw.firstPartyPackages = [{ root: "shared", name: "@acme/shared" }];
    write(root, "monocarve.config.json", `${JSON.stringify(raw, null, 2)}\n`);
    write(root, "shared/package.json", SHARED_PACKAGE_JSON);
    write(root, "shared/index.ts", 'export { renderChart } from "../apps/web/src/widgets/chart.ts";\n');
    fixtureGit(root, "add", "-A");
    fixtureGit(root, "commit", "-qm", "test: add exact-root package that reaches into application code");

    const { config } = await loadConfig({ cwd: root });
    const graph = await scanDependencyGraph({ config, rootDir: root, noCache: true });
    const manifest = buildPlanSync({
      config, rootDir: root, graph,
      candidate: buildPortfolio({ config, graph }).candidates.find((entry) => entry.eligible)!,
      baselineCommit: graph.commit!, packageName: "@acme/chart-shared-violation",
    });

    const edge = { file: "shared/index.ts", target: "apps/web/src/widgets/chart.ts" };
    // The violation is older than the plan, so the compiler records it and the
    // audit reports it as evidence instead of vetoing an extraction that never
    // went near it.
    expect(manifest.boundaryBaseline?.edges).toContainEqual(edge);
    const report = auditPlanSync({ config, rootDir: root, manifest });
    expect(report.failures).not.toContain("shared/index.ts imports application code: ../apps/web/src/widgets/chart.ts");
    expect(report.boundaryBaseline.observed).toContain("shared/index.ts -> apps/web/src/widgets/chart.ts");

    // The negative half, in the same tree: the identical edge against a plan
    // that did not record it — every plan compiled before the violation
    // existed — is exactly the failure the rule is for.
    const withoutBaseline = auditPlanSync({
      config,
      rootDir: root,
      manifest: { ...manifest, boundaryBaseline: { digest: EMPTY_BASELINE_DIGEST, edges: [] } },
    });
    expect(withoutBaseline.failures).toContain("shared/index.ts imports application code: ../apps/web/src/widgets/chart.ts");
    expect(withoutBaseline.passed).toBe(false);
  }, 300_000);

  test("assigns the exact root as owner and a package zone to a reached graph node", () => {
    const entry = "apps/web/src/entry.ts";
    const shared = "shared/index.ts";
    const root = fixtureRepo({ [entry]: 'import "@acme/shared";\n', [shared]: SHARED_INDEX });
    const config = parseConfig({
      applications: [{ name: "web", sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json" }],
      packageRoots: ["libs"],
      firstPartyPackages: [{ root: "shared", name: "@acme/shared" }],
      scaffoldTemplates: { packageJson: { contents: '{"name":"root"}' } },
    });
    const graph = buildDependencyGraph({
      config,
      rootDir: root,
      reports: {
        web: {
          modules: [
            { source: entry, dependencies: [{ module: "@acme/shared", resolved: shared }] },
            { source: shared, dependencies: [] },
          ],
        },
      },
    });
    const node = graph.nodes.get(shared);
    expect(node?.owner).toBe("shared");
    expect(node?.zone).toBe("package");
  });
});
