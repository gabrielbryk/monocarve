/**
 * The whole pipeline, applied for real.
 *
 * The fixture workspace is copied into a standalone git repository so the
 * extraction can actually land: plan, commit the plan, apply, audit. Everything
 * else in the suite proves a stage in isolation; this proves the stages agree —
 * that a manifest compiled by the builder is one the journal can replay, that
 * the commits it produces are the shape the audit expects, and that the audit
 * of a real applied extraction passes every proof rather than being vacuously
 * green.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pnpmAdapter } from "../src/adapters/pnpm.ts";
import { loadConfig } from "../src/config.ts";
import { scanDependencyGraph } from "../src/graph/cruiser.ts";
import { buildPortfolio } from "../src/portfolio/rank.ts";
import { buildPlanSync, serializeManifest } from "../src/plan/build.ts";
import { applyPlan } from "../src/transaction/apply.ts";
import { auditPlanSync } from "../src/transaction/audit.ts";
import { cleanupFixtures, fixtureGit, scratchDirectory, write } from "./support/fixture-repo.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "../fixtures/basic-monorepo");

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

describe("end to end", () => {
  afterAll(cleanupFixtures);

  test("compiles, applies, and audits a module-preserving extraction of the widget closure", async () => {
    const root = standaloneWorkspace();
    const raw = JSON.parse(readFileSync(join(root, "monocarve.config.json"), "utf8")) as {
      scaffoldTemplates: Record<string, unknown>;
    };
    raw.scaffoldTemplates.publicSurface = {
      mode: "subpaths",
      keyTemplate: "./{pathNoExtension}",
      targetTemplate: "./src/{path}",
    };
    const appTsconfigPath = "apps/web/tsconfig.json";
    const appTsconfig = JSON.parse(readFileSync(join(root, appTsconfigPath), "utf8")) as Record<string, unknown>;
    appTsconfig.references = [];
    write(root, "monocarve.config.json", `${JSON.stringify(raw, null, 2)}\n`);
    write(root, appTsconfigPath, `${JSON.stringify(appTsconfig, null, 2)}\n`);
    fixtureGit(root, "add", "--", "monocarve.config.json", appTsconfigPath);
    fixtureGit(root, "commit", "-qm", "test: publish module subpaths");
    const { config } = await loadConfig({ cwd: root });

    const graph = await scanDependencyGraph({ config, rootDir: root, noCache: true });
    const portfolio = buildPortfolio({ config, graph });
    const candidate = portfolio.candidates.find((entry) => entry.eligible && entry.assets.length > 0);
    expect(candidate).toBeDefined();

    const manifest = buildPlanSync({
      config,
      rootDir: root,
      graph,
      candidate: candidate!,
      baselineCommit: graph.commit!,
      packageName: "@acme/chart",
    });

    // The declared evaluation inventory, from the real builder against real
    // sources, and it covers the closure rather than the moved set.
    //
    // `chart.ts` has `import "./chart.css"` at its top level and `types.ts` has
    // nothing but declarations, so exactly one of the two *moved* modules is
    // named, at its target path. The second record is the whole point: nothing
    // moves `libs/format/src/number.ts` and nothing in `apps/web` imports it —
    // `chart.ts` imports `@acme/format`, whose entrypoint re-exports it, and its
    // top-level `registry.set(...)` now runs for every consumer repointed at
    // `@acme/chart`. An inventory limited to the moved files misses it entirely,
    // and one that recorded it as `moved`, or at a target path under
    // `libs/chart/`, would be describing a file this plan does not produce.
    expect(manifest.evaluationEffects).toEqual([
      { subject: "module", reach: "moved", path: "libs/chart/src/widgets/chart.ts", kinds: ["side-effect-import"] },
      {
        subject: "module",
        reach: "reached",
        path: "libs/format/src/number.ts",
        kinds: ["expression-statement", "initializer-call"],
      },
    ]);
    // The generated barrel is inventoried too; `export *` does no work itself,
    // so it contributes nothing here.
    expect(
      manifest.evaluationEffects.some((entry) => entry.subject === "module" && entry.path === "libs/chart/src/index.ts"),
    ).toBe(false);

    const manifestPath = "plans/chart.json";
    write(root, manifestPath, serializeManifest(manifest));
    fixtureGit(root, "add", "--", manifestPath);
    fixtureGit(root, "commit", "-qm", manifest.commits.plan!.subject);

    const result = await applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true });
    expect(result.failure).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.moveCommit).toBeDefined();
    expect(result.wiringCommit).toBeDefined();

    // The move commit is nothing but exact renames.
    const moveDiff = fixtureGit(root, "show", "--name-status", "--find-renames=100%", "--format=", "HEAD~1")
      .split("\n")
      .filter(Boolean);
    expect(moveDiff).toHaveLength(4);
    expect(moveDiff.every((line) => line.startsWith("R100"))).toBe(true);

    // The wiring commit carries every content change, and nothing else —
    // including the regenerated ledger, which no operation writes and which the
    // extraction nonetheless invalidates.
    const wiring = fixtureGit(root, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).sort();
    expect(wiring).toEqual(
      [
        "apps/web/package.json",
        "apps/web/src/main.ts",
        "apps/web/tsconfig.json",
        "generated/module-ledger.json",
        "libs/chart/moon.yml",
        "libs/chart/package.json",
        "libs/chart/src/index.ts",
        "libs/chart/tsconfig.json",
        "pnpm-lock.yaml",
      ].sort(),
    );

    // The plan declared the artifact, its blast radius named it, and the
    // committed bytes are the generator's — three modules' worth of agreement,
    // any one of which failing would leave the workspace's own ledger gate
    // failing on `develop` after the extraction landed.
    const ledgerRecord = manifest.generatedFiles.find((entry) => entry.path === "generated/module-ledger.json");
    expect(ledgerRecord?.regenerateOnApply).toBe(true);
    expect(ledgerRecord?.regenerate).toBe("sh scripts/module-ledger.sh");
    expect(manifest.changedFiles).toContain("generated/module-ledger.json");
    // The mock-only retained consumer remains alongside the unrelated module;
    // the extracted production closure itself still leaves the application.
    expect(JSON.parse(readFileSync(join(root, "generated/module-ledger.json"), "utf8"))).toEqual({
      "apps/web/src": 2,
      "apps/api/src": 2,
    });
    expect(fixtureGit(root, "show", "HEAD:generated/module-ledger.json")).toContain('"apps/web/src": 2');

    // The package is real: scaffolding, dependencies, project references, barrel.
    const created = JSON.parse(readFileSync(join(root, "libs/chart/package.json"), "utf8")) as {
      name: string;
      dependencies: Record<string, string>;
      exports: Record<string, unknown>;
    };
    expect(created.name).toBe("@acme/chart");
    expect(created.dependencies["@acme/format"]).toBe("workspace:*");
    expect(created.exports["./widgets/chart"]).toBe("./src/widgets/chart.ts");
    expect(created.exports["./types"]).toBe("./src/types.ts");
    expect(readFileSync(join(root, "libs/chart/src/index.ts"), "utf8")).toBe("");
    expect(JSON.parse(readFileSync(join(root, "libs/chart/tsconfig.json"), "utf8")).references).toEqual([
      { path: "../format" },
    ]);
    expect(JSON.parse(readFileSync(join(root, appTsconfigPath), "utf8")).references).toEqual([{ path: "../../libs/chart" }]);

    // The consumer moved to the package specifier, and the asset travelled.
    const consumerText = readFileSync(join(root, "apps/web/src/main.ts"), "utf8");
    expect(consumerText).toContain('from "@acme/chart/widgets/chart"');
    expect(consumerText).toContain('from "@acme/chart/types"');
    // `main.ts` reaches the closure through two different specifiers — a value
    // import of `./widgets/chart.ts` and a type import of `./types.ts`. Both are
    // repointed, so the manifest has to declare both: a plan that performed two
    // rewrites while recording one would leave validation blind to the second.
    expect(consumerText).not.toContain("./widgets/chart.ts");
    expect(consumerText).not.toContain("./types.ts");
    const declared = manifest.consumers.find((entry) => entry.file === "apps/web/src/main.ts");
    expect(declared?.specifiers.map((rewrite) => rewrite.from).sort()).toEqual(["./types.ts", "./widgets/chart.ts"]);
    expect(existsSync(join(root, "libs/chart/src/widgets/chart.css"))).toBe(true);

    // The lockfile gained one importer block and the consuming app gained a link.
    const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
    expect(pnpmAdapter.importerBlock(lockfile, "libs/chart")).toBeDefined();
    expect(pnpmAdapter.importerBlock(lockfile, "apps/web")).toContain("link:../../libs/chart");

    const report = auditPlanSync({ config, rootDir: root, manifest });
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.externalConsumerCompile.passed).toBe(true);
    expect(report.codemodReplay.passed).toBe(true);
    expect(report.entrypointClosure.passed).toBe(true);
    expect(report.entrypointClosure.checked).toBeGreaterThan(0);
    expect(report.graphEvidence.movedPathEdges).toEqual([]);

    const packagePath = "libs/chart/package.json";
    const chartPath = "libs/chart/src/widgets/chart.ts";
    const typesPath = "libs/chart/src/types.ts";
    const packageBytes = readFileSync(join(root, packagePath), "utf8");
    const chartBytes = readFileSync(join(root, chartPath), "utf8");
    const typesBytes = readFileSync(join(root, typesPath), "utf8");

    // A package export that silently points at the wrong landed module must
    // fail the independent boundary proof, even though the target file exists.
    created.exports["./widgets/chart"] = "./src/types.ts";
    write(root, packagePath, `${JSON.stringify(created, null, 2)}\n`);
    const tampered = auditPlanSync({ config, rootDir: root, manifest, skipCompileProof: true });
    expect(tampered.boundaryRules.failures).toContain(
      "package subpath ./widgets/chart does not target ./src/widgets/chart.ts",
    );
    expect(tampered.passed).toBe(false);

    // Deleting the key is observably different from pointing it elsewhere;
    // both must fail the exact configured-target assertion.
    write(root, packagePath, packageBytes);
    const withoutChartExport = JSON.parse(packageBytes) as typeof created;
    delete withoutChartExport.exports["./widgets/chart"];
    write(root, packagePath, `${JSON.stringify(withoutChartExport, null, 2)}\n`);
    const missingKey = auditPlanSync({ config, rootDir: root, manifest, skipCompileProof: true });
    expect(missingKey.boundaryRules.failures).toContain(
      "package subpath ./widgets/chart does not target ./src/widgets/chart.ts",
    );

    // An exports map whose path is right but whose file disappeared cannot
    // pass merely because lexical path resolution still agrees.
    write(root, packagePath, packageBytes);
    rmSync(join(root, chartPath));
    const missingTarget = auditPlanSync({ config, rootDir: root, manifest, skipCompileProof: true });
    expect(missingTarget.boundaryRules.failures).toContain(
      "package subpath ./widgets/chart does not expose renderChart",
    );

    // The surface check distinguishes runtime symbols and type-only symbols.
    // These two corruptions prove each kind can make the proof fail.
    write(root, chartPath, chartBytes.replace("export function renderChart", "function renderChart"));
    const missingValue = auditPlanSync({ config, rootDir: root, manifest, skipCompileProof: true });
    expect(missingValue.boundaryRules.failures).toContain(
      "package subpath ./widgets/chart does not expose renderChart",
    );
    write(root, chartPath, chartBytes);
    write(root, typesPath, typesBytes.replace("export interface Point", "interface Point"));
    const missingType = auditPlanSync({ config, rootDir: root, manifest, skipCompileProof: true });
    expect(missingType.boundaryRules.failures).toContain("package subpath ./types does not expose Point");
    write(root, typesPath, typesBytes);

    // Default is represented as a normal runtime export in the proof. This
    // negative uses a strengthened manifest claim to make that branch fail;
    // plan validation separately owns proving that claims equal source facts.
    const requiringDefault = structuredClone(manifest);
    const chartModule = requiringDefault.target.publicModules?.find((module) => module.exportKey === "./widgets/chart");
    expect(chartModule).toBeDefined();
    (chartModule!.requiredExports as { name: string; typeOnly: boolean }[]).push({ name: "default", typeOnly: false });
    const missingDefault = auditPlanSync({ config, rootDir: root, manifest: requiringDefault, skipCompileProof: true });
    expect(missingDefault.boundaryRules.failures).toContain(
      "package subpath ./widgets/chart does not expose default",
    );

    // Finally alter the manifest mapping instead of the landed package. The
    // audit must compare the two sources of truth rather than accepting either
    // one in isolation.
    const forgedMapping = structuredClone(manifest);
    const forgedChart = forgedMapping.target.publicModules?.find((module) => module.exportKey === "./widgets/chart");
    expect(forgedChart).toBeDefined();
    Object.assign(forgedChart!, { exportTarget: "./src/types.ts", target: typesPath });
    const manifestTamper = auditPlanSync({ config, rootDir: root, manifest: forgedMapping, skipCompileProof: true });
    expect(manifestTamper.boundaryRules.failures).toContain(
      "package subpath ./widgets/chart does not target ./src/types.ts",
    );
  }, 300_000);

  test("applies and audits a retained cross-owner test as a dev-only consumer", async () => {
    const root = standaloneWorkspace();
    // The test reaches the web closure and API composition code.  It therefore
    // cannot travel, but its API owner must receive a dev-only package edge.
    write(
      root,
      "apps/api/src/chart-consumer.test.ts",
      'import { renderChart } from "../../web/src/widgets/chart.ts";\nimport { start } from "./server.ts";\nvoid renderChart;\nvoid start;\n',
    );
    const raw = JSON.parse(readFileSync(join(root, "monocarve.config.json"), "utf8")) as Record<string, unknown>;
    raw.testRelocation = { strategy: "self-contained" };
    // This fixture's legacy project gate intentionally names web; retaining a
    // test in api correctly adds api as a gate owner, so make the gate generic.
    (raw.gates as Record<string, unknown>).project = ["test -d {owner}"];
    write(root, "monocarve.config.json", `${JSON.stringify(raw, null, 2)}\n`);
    fixtureGit(root, "add", "-A");
    fixtureGit(root, "commit", "-qm", "test: add retained consumer");

    const { config } = await loadConfig({ cwd: root });
    const graph = await scanDependencyGraph({ config, rootDir: root, noCache: true });
    const candidate = buildPortfolio({ config, graph }).candidates.find(
      (entry) => entry.eligible && entry.files.includes("apps/web/src/widgets/chart.ts"),
    );
    expect(candidate).toBeDefined();
    const manifest = buildPlanSync({
      config,
      rootDir: root,
      graph,
      candidate: candidate!,
      baselineCommit: graph.commit!,
      packageName: "@acme/chart-retained",
    });
    expect(manifest.source.tests).not.toContain("apps/api/src/chart-consumer.test.ts");
    expect(manifest.consumers).toContainEqual(
      expect.objectContaining({ file: "apps/api/src/chart-consumer.test.ts", owner: "apps/api", dependencySection: "dev" }),
    );
    const manifestPath = "plans/chart-retained.json";
    write(root, manifestPath, serializeManifest(manifest));
    fixtureGit(root, "add", "--", manifestPath);
    fixtureGit(root, "commit", "-qm", manifest.commits.plan!.subject);

    const result = await applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true });
    expect(result.ok).toBe(true);
    const apiPackage = JSON.parse(readFileSync(join(root, "apps/api/package.json"), "utf8")) as { devDependencies?: Record<string, string> };
    expect(apiPackage.devDependencies?.["@acme/chart-retained"]).toBe("workspace:*");
    expect(readFileSync(join(root, "apps/api/src/chart-consumer.test.ts"), "utf8")).toContain('from "@acme/chart-retained"');
    expect(pnpmAdapter.importerBlock(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"), "apps/api")).toContain("devDependencies:");
    expect(auditPlanSync({ config, rootDir: root, manifest }).passed).toBe(true);
  }, 300_000);
});
