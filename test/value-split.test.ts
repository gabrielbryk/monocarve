import { afterEach, describe, expect, test } from "bun:test";

import { buildDependencyGraph } from "../src/graph/build.ts";
import { compileValueSplit } from "../src/prepare/value-split.ts";
import { auditPreparationSync } from "../src/prepare/audit.ts";
import { executePreparationJournal } from "../src/prepare/journal.ts";
import { preparationFilesystemOperations, simulatePreparation } from "../src/prepare/simulate.ts";
import { runPreparationPostJournalPreparers } from "../src/prepare/post-journal.ts";
import { resolveCommit } from "../src/util/git.ts";
import { hashText } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureConfig, fixtureRepo } from "./support/fixture-repo.ts";

afterEach(cleanupFixtures);

const SOURCE = "apps/api/src/mixed.ts";
const TARGET = "apps/api/src/shared/normalize.ts";

function setup(source: string) {
  const root = fixtureRepo({
    "apps/api/tsconfig.json": JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler" }, include: ["src"] }),
    [SOURCE]: source,
    "apps/api/src/trim.ts": "export const trim = (value: string): string => value.trim();\n",
    "apps/api/src/consumer.ts": 'import { normalize } from "./mixed.js";\nexport const result = normalize(" value ");\n',
    "apps/api/ledger.txt": "baseline\n",
    "apps/api/stable-ledger.txt": "stable\n",
  });
  const config = fixtureConfig(root, {
    preparation: { gates: { workspace: ["grep -q generated apps/api/ledger.txt"] }, commit: { subject: "refactor: split normalize value" } },
    postJournalPreparers: [{ id: "ledger", phase: "after-journal-before-gates", command: "printf 'generated\\n' > apps/api/ledger.txt", outputs: ["apps/api/ledger.txt", "apps/api/stable-ledger.txt"], triggers: ["^apps/api/src/"] }],
    valueSplits: [{ id: "normalize-value", source: SOURCE, symbol: "normalize", target: TARGET, targetModuleSpecifier: "./shared/normalize.js" }],
  });
  const baseline = resolveCommit(root, "HEAD");
  const graph = buildDependencyGraph({ config, rootDir: root, reports: { api: { modules: [
    { source: SOURCE, dependencies: [] },
    { source: "apps/api/src/consumer.ts", dependencies: [{ resolved: SOURCE, module: "./mixed.js" }] },
  ] } }, commit: baseline.commit });
  const rendering = { commit: { subject: "refactor: split normalize value" }, gates: { package: [], project: [], workspace: ["grep -q generated apps/api/ledger.txt"] } };
  return { root, config, baseline, graph, rendering };
}

describe("value split", () => {
  test("moves exact standalone value bytes and retains a compatibility export", async () => {
    const fixture = setup('export const retained = 1;\n\n/** Normalize a value. */\nexport function normalize(value: string): string {\n  return value.trim();\n}\n');
    const manifest = compileValueSplit({ rootDir: fixture.root, config: fixture.config, graph: fixture.graph, baselineCommit: fixture.baseline.commit, graphDigest: hashText("graph"), splitId: "normalize-value", rendering: fixture.rendering });
    const writes = manifest.operations.filter((item) => item.kind === "write-file");
    expect(writes.find((item) => item.file.path === TARGET)?.contents).toContain("/** Normalize a value. */\nexport function normalize");
    expect(writes.find((item) => item.file.path === SOURCE)?.contents).toContain('export { normalize } from "./shared/normalize.js";');
    expect(manifest.changedFiles).toContain("apps/api/ledger.txt");
    expect(manifest.changedFiles).toContain("apps/api/stable-ledger.txt");
    const simulation = await simulatePreparation({ config: fixture.config, rootDir: fixture.root, manifest, baselineGraphScanner: async ({ baselineCommit }) => ({ commit: baselineCommit, digest: manifest.graphDigest }) });
    expect(simulation.ok).toBe(true);
    executePreparationJournal({ rootDir: fixture.root, operations: preparationFilesystemOperations(manifest) });
    expect(runPreparationPostJournalPreparers(fixture.config, fixture.root, manifest)).toMatchObject({ ok: true, changed: true });
    expect(auditPreparationSync({ config: fixture.config, rootDir: fixture.root, manifest, freshGraph: { commit: fixture.baseline.commit, digest: manifest.graphDigest } }).passed).toBe(true);
  });

  test("moves an exclusively owned local helper dependency", () => {
    const fixture = setup('function trim(value: string): string { return value.trim(); }\nexport function normalize(value: string): string { return trim(value); }\n');
    const manifest = compileValueSplit({ rootDir: fixture.root, config: fixture.config, graph: fixture.graph, baselineCommit: fixture.baseline.commit, graphDigest: hashText("graph"), splitId: "normalize-value", rendering: fixture.rendering });
    const target = manifest.operations.find((item) => item.kind === "write-file" && item.file.path === TARGET);
    expect(target?.kind === "write-file" ? target.contents : "").toContain("function trim");
  });

  test("refuses a helper dependency that retained code still uses", () => {
    const fixture = setup('function trim(value: string): string { return value.trim(); }\nexport const retained = trim("x");\nexport function normalize(value: string): string { return trim(value); }\n');
    expect(() => compileValueSplit({ rootDir: fixture.root, config: fixture.config, graph: fixture.graph, baselineCommit: fixture.baseline.commit, graphDigest: hashText("graph"), splitId: "normalize-value", rendering: fixture.rendering })).toThrow(/still used by retained declaration.*trim/);
  });

  test("copies and relocates a compiler-resolved relative import", () => {
    const fixture = setup('import { trim } from "./trim.js";\nexport function normalize(value: string): string { return trim(value); }\n');
    const manifest = compileValueSplit({ rootDir: fixture.root, config: fixture.config, graph: fixture.graph, baselineCommit: fixture.baseline.commit, graphDigest: hashText("graph"), splitId: "normalize-value", rendering: fixture.rendering });
    const target = manifest.operations.find((item) => item.kind === "write-file" && item.file.path === TARGET);
    expect(target?.kind === "write-file" ? target.contents : "").toContain('from "../trim.js"');
  });

  test("refuses effectful runtime initialization whose evaluation order would move", () => {
    const fixture = setup('export const normalize = (() => (value: string): string => value.trim())();\n');
    expect(() => compileValueSplit({ rootDir: fixture.root, config: fixture.config, graph: fixture.graph, baselineCommit: fixture.baseline.commit, graphDigest: hashText("graph"), splitId: "normalize-value", rendering: fixture.rendering })).toThrow(/top-level evaluation effects/);
  });
});
