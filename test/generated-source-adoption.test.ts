import { afterEach, describe, expect, test } from "bun:test";

import { buildDependencyGraph, type ScanReport } from "../src/graph/build.ts";
import { compileGeneratedSourceAdoption } from "../src/prepare/generated-source-adoption.ts";
import { auditPreparationSync } from "../src/prepare/audit.ts";
import { preparationFilesystemOperations } from "../src/prepare/simulate.ts";
import { executePreparationJournal } from "../src/prepare/journal.ts";
import { resolveCommit } from "../src/util/git.ts";
import { hashText } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureConfig, fixtureGit, fixtureRepo, write } from "./support/fixture-repo.ts";

afterEach(cleanupFixtures);

const ARTIFACT = "apps/api/src/contracts.ts";
const SOURCE = "spec/contracts.json";
const GENERATOR = "apps/api/scripts/gen.ts";
const HEADER = `// @generated - DO NOT EDIT\n// Source: ${SOURCE}\n// Regenerate: bun ${GENERATOR}\n`;

function setup(extraOutput = false) {
  const root = fixtureRepo({
    "apps/api/tsconfig.json": JSON.stringify({ compilerOptions: { module: "ESNext" }, include: ["src"] }),
    [ARTIFACT]: `${HEADER}export const Contract = 1;\n`,
    [GENERATOR]: "export {};\n",
    ...(extraOutput ? { "apps/api/src/other.ts": `${HEADER}export const Other = 1;\n` } : {}),
  });
  const config = fixtureConfig(root, {
    preparation: { gates: { workspace: ["true"] }, commit: { subject: "refactor: adopt generated contracts" } },
    generatedSourceAdoptions: [{ id: "contracts", artifacts: [{ path: ARTIFACT, missingSource: SOURCE, removeHeaderLines: 3 }], retireGenerator: GENERATOR }],
  });
  const baseline = resolveCommit(root, "HEAD");
  const modules: ScanReport["modules"] = [
    { source: ARTIFACT, dependencies: [] }, { source: GENERATOR, dependencies: [] },
    ...(extraOutput ? [{ source: "apps/api/src/other.ts", dependencies: [] }] : []),
  ];
  const graph = buildDependencyGraph({ config, rootDir: root, reports: { api: { modules } }, commit: baseline.commit });
  return { root, config, baseline, graph };
}

describe("generated-source adoption", () => {
  test("records exact header removal, applies it, and audits generator retirement", () => {
    const { root, config, baseline, graph } = setup();
    const manifest = compileGeneratedSourceAdoption({ rootDir: root, config, graph, baselineCommit: baseline.commit, graphDigest: hashText("graph"), adoptionId: "contracts", policySpecifier: "adopt:contracts", rendering: { commit: { subject: "refactor: adopt generated contracts" }, gates: { package: [], project: [], workspace: ["true"] } } });
    const adoption = manifest.operations.find((item) => item.kind === "adopt-generated-source");
    expect(adoption?.kind).toBe("adopt-generated-source");
    if (adoption?.kind !== "adopt-generated-source") throw new Error("expected adoption");
    expect(adoption.removedHeader.hash).toBe(hashText(HEADER));
    expect(adoption.contents).toBe("export const Contract = 1;\n");
    executePreparationJournal({ rootDir: root, operations: preparationFilesystemOperations(manifest) });
    const audit = auditPreparationSync({ config, rootDir: root, manifest, freshGraph: { commit: baseline.commit, digest: hashText("graph") } });
    expect(audit.passed).toBe(true);
  });

  test("refuses generator retirement when another generated output survives", () => {
    const { root, config, baseline, graph } = setup(true);
    expect(() => compileGeneratedSourceAdoption({ rootDir: root, config, graph, baselineCommit: baseline.commit, graphDigest: hashText("graph"), adoptionId: "contracts", policySpecifier: "adopt:contracts", rendering: { commit: { subject: "refactor: adopt generated contracts" }, gates: { package: [], project: [], workspace: ["true"] } } })).toThrow(/not exhaustive.*other\.ts/);
  });

  test("refuses adoption when the declared source exists", () => {
    const fixture = setup();
    // This negative uses a new committed baseline so the compiler cannot hide
    // behind a stale working-tree observation.
    write(fixture.root, SOURCE, "{}\n");
    fixtureGit(fixture.root, "add", "--", SOURCE);
    fixtureGit(fixture.root, "commit", "-qm", "test: restore schema");
    const baseline = resolveCommit(fixture.root, "HEAD");
    const graph = { ...fixture.graph, commit: baseline.commit };
    expect(() => compileGeneratedSourceAdoption({ rootDir: fixture.root, config: fixture.config, graph, baselineCommit: baseline.commit, graphDigest: hashText("graph"), adoptionId: "contracts", policySpecifier: "adopt:contracts", rendering: { commit: { subject: "refactor: adopt generated contracts" }, gates: { package: [], project: [], workspace: ["true"] } } })).toThrow(/source still exists/);
  });
});
