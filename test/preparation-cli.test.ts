import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { appendCampaignChild, createCampaignLedger, serializeCampaignLedger, type CampaignChildPlan } from "../src/campaign/index.ts";
import { createCampaignLedgerFile } from "../src/commands/campaign-ledger-file.ts";
import { writeCampaignLedgerAtomically } from "../src/commands/preparation.ts";
import { hashJson, stableStringify } from "../src/util/hash.ts";
import { committedWorkspace, existsSync, readFileSync, runIn, runJsonIn, writeFileSync } from "./support/cli.ts";
import { cleanupFixtures, fixtureGit } from "./support/fixture-repo.ts";
import { appliedPairLedger, configurePreparationPolicy, reviewedPreparationPlan, scanMetrics } from "./support/preparation-cli.ts";
afterAll(cleanupFixtures);

test("seams compiles a deterministic read-only proposal from a selected declaration SCC", async () => {
  const root = committedWorkspace();
  const candidates = await runJsonIn<{ splitCandidates: { id: string }[] }>(root, "split-candidates", "--file", "apps/web/src/widgets/chart.ts");
  const candidate = candidates.splitCandidates[0];
  if (!candidate) throw new Error("fixture did not produce a split candidate");

  const seam = await runJsonIn<{
    schemaVersion: number;
    sourcePath: string;
    candidateId: string;
    targetPath?: string;
    movedGroups: { name: string }[];
    requiredImports: unknown[];
  }>(root, "seams", "--file", "apps/web/src/widgets/chart.ts", "--candidate", candidate.id, "--target", "apps/web/src/widgets/chart-types.ts");

  expect(seam.schemaVersion).toBe(1);
  expect(seam.sourcePath).toBe("apps/web/src/widgets/chart.ts");
  expect(seam.candidateId).toBe(candidate.id);
  expect(seam.targetPath).toBe("apps/web/src/widgets/chart-types.ts");
  expect(seam.movedGroups).toHaveLength(1);
  expect(seam.requiredImports).toHaveLength(1);
}, 15_000);

test("prepare-apply refuses a schema-v1 preparer manifest with the correct recovery command", async () => {
  const root = committedWorkspace();
  const path = "plans/preparer.json";
  mkdirSync(join(root, "plans"), { recursive: true });
  writeFileSync(join(root, path), JSON.stringify({ schemaVersion: 1, planId: "preparer-plan", preparer: { id: "rewrite-boundary", phase: "pre-extraction" } }));
  const result = await runIn(root, "prepare-apply", "--plan", path, "--commit");
  expect(result.code).toBe(64);
  expect(result.stderr).toContain(`is a preparer manifest; use preparer-apply --plan ${path}`);
  expect(result.stderr).not.toContain("TypeError");
});

test("seams-multi deterministically analyzes an explicit configured file scope", async () => {
  const root = committedWorkspace();
  const arguments_ = ["seams-multi", "--file", "apps/web/src/widgets/chart.ts", "--file", "apps/web/src/types.ts"] as const;
  const first = await runJsonIn<{ id: string; sourceHashes: Record<string, string>; edges: { sourceName: string; targetName: string; confidence: string }[] }>(
    root,
    ...arguments_,
  );
  const second = await runJsonIn<typeof first>(root, ...arguments_);

  expect(stableStringify(second)).toBe(stableStringify(first));
  expect(Object.keys(first.sourceHashes)).toEqual(["apps/web/src/types.ts", "apps/web/src/widgets/chart.ts"]);
  expect(first.edges).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sourceName: "renderChart", targetName: "Series", confidence: "exact" }),
      expect.objectContaining({ sourceName: "toLabel", targetName: "Point", confidence: "exact" }),
    ]),
  );

  const refused = await runIn(root, "seams-multi", "--file", "apps/web/src/types.ts");
  expect(refused.code).toBe(64);
  expect(refused.stderr).toContain("at least two --file <path> values are required");
}, 30_000);

test("prepare-plan persists only an explicitly reviewed type-only preparation manifest", async () => {
  const root = committedWorkspace();
  const source = "apps/web/src/preparation-fixture.ts";
  const configPath = join(root, "monocarve.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  config.preparation = { commit: { subject: "refactor: prepare {sourcePath}" }, gates: { workspace: ["bun run typecheck"] } };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(join(root, source), "export interface PreparationFixture { readonly id: string; }\n");
  fixtureGit(root, "add", "--", "monocarve.config.json", source);
  fixtureGit(root, "commit", "-qm", "test: add preparation fixture");
  const candidates = await runJsonIn<{ splitCandidates: { id: string; groupIds: string[] }[] }>(root, "split-candidates", "--file", source);
  const candidate = candidates.splitCandidates[0];
  const group = candidate?.groupIds[0];
  if (!candidate || !group) throw new Error("fixture did not produce a declaration SCC");

  const manifest = await runJsonIn<{ planId: string; graphDigest: string; output: string; written: boolean }>(
    root,
    "prepare-plan",
    "--file",
    source,
    "--candidate",
    candidate.id,
    "--target",
    "apps/web/src/preparation-fixture-types.ts",
    "--module-specifier",
    "@acme/preparation-fixture-types",
    "--group",
    group,
    "--write",
  );
  expect(manifest.planId).toStartWith("prepare-");
  expect(manifest.graphDigest).toHaveLength(64);
  expect(manifest.written).toBe(true);
  expect(existsSync(join(root, manifest.output))).toBe(true);
}, 15_000);

test("campaign advance writes exactly one fresh reviewed preparation child", async () => {
  const { root, manifest, graph } = await reviewedPreparationPlan();
  const ledger = createCampaignLedger({
    campaignId: "decompose-fixture",
    objective: "prepare one reviewed type seam",
    stopConditions: [],
    baselineCommit: manifest.baseline.commit,
    initialGraph: graph,
  });
  const campaignPath = ".monocarve/campaigns/campaign.json";
  mkdirSync(join(root, ".monocarve/campaigns"), { recursive: true });

  writeFileSync(join(root, campaignPath), serializeCampaignLedger(ledger));

  const result = await runJsonIn<{ written: boolean; campaign: { children: { status: string; pairId: string }[] } }>(
    root,
    "campaign",
    "advance",
    "--campaign",
    campaignPath,
    "--next-plan",
    manifest.output,
    "--pair",
    "preparation-fixture",
    "--write",
  );

  expect(result.written).toBe(true);
  expect(result.campaign.children).toMatchObject([{ status: "planned", pairId: "preparation-fixture" }]);
  expect(JSON.parse(readFileSync(join(root, campaignPath), "utf8"))).toMatchObject({ children: [{ status: "planned", pairId: "preparation-fixture" }] });
}, 30_000);

test("campaign record audits, rescans, and atomically writes an applied preparation child", async () => {
  const { root, manifest, graph } = await reviewedPreparationPlan();
  fixtureGit(root, "add", "-f", "--", manifest.output);
  fixtureGit(root, "commit", "-qm", manifest.commits.prepare.subject);
  const child: CampaignChildPlan = {
    id: manifest.planId,
    pairId: "preparation-fixture",
    kind: "preparation",
    planId: manifest.planId,
    baselineCommit: manifest.baseline.commit,
  };
  const ledger = appendCampaignChild(
    createCampaignLedger({
      campaignId: "record-fixture",
      objective: "record one verified preparation",
      stopConditions: [],
      baselineCommit: manifest.baseline.commit,
      initialGraph: graph,
    }),
    child,
  );

  const applied = await runJsonIn<{ ok: boolean }>(root, "prepare-apply", "--plan", manifest.output, "--commit");
  expect(applied.ok).toBe(true);
  const campaignPath = ".monocarve/campaigns/campaign.json";
  mkdirSync(join(root, ".monocarve/campaigns"), { recursive: true });

  writeFileSync(join(root, campaignPath), serializeCampaignLedger(ledger));
  const result = await runJsonIn<{ written: boolean; campaign: { children: { status: string }[] } }>(
    root,
    "campaign",
    "record",
    "--campaign",
    campaignPath,
    "--plan",
    manifest.output,
    "--pair",
    "preparation-fixture",
    "--write",
  );

  expect(result.written).toBe(true);
  expect(result.campaign.children).toMatchObject([{ status: "applied" }]);
  expect(JSON.parse(readFileSync(join(root, campaignPath), "utf8"))).toMatchObject({ children: [{ status: "applied" }] });
}, 45_000);

test("campaign advance durably records the no-next-child completion", async () => {
  const root = committedWorkspace();
  const graph = await scanMetrics(root);
  const head = fixtureGit(root, "rev-parse", "HEAD");
  const ledger = appliedPairLedger(head, graph);
  const campaignPath = ".monocarve/campaigns/campaign.json";
  mkdirSync(join(root, ".monocarve/plans"), { recursive: true });
  mkdirSync(join(root, ".monocarve/campaigns"), { recursive: true });

  writeFileSync(join(root, campaignPath), serializeCampaignLedger(ledger));

  const result = await runJsonIn<{ written: boolean; reason: string; campaign: { status: string } }>(
    root,
    "campaign",
    "advance",
    "--campaign",
    campaignPath,
    "--write",
  );

  expect(result).toMatchObject({ written: true, reason: "no-next-child", campaign: { status: "completed" } });
  expect(JSON.parse(readFileSync(join(root, campaignPath), "utf8"))).toMatchObject({ status: "completed" });
}, 30_000);

test("prepare-plan refuses an unresolved selected relative type import", async () => {
  const root = committedWorkspace();
  const source = "apps/web/src/unresolved-import-fixture.ts";
  configurePreparationPolicy(root);
  writeFileSync(join(root, source), 'import type { Missing } from "./not-present.ts";\nexport interface UnresolvedFixture { readonly missing: Missing; }\n');
  fixtureGit(root, "add", "--", "monocarve.config.json", source);
  fixtureGit(root, "commit", "-qm", "test: add unresolved preparation fixture");
  const candidates = await runJsonIn<{ splitCandidates: { id: string; groupIds: string[] }[] }>(root, "split-candidates", "--file", source);
  const candidate = candidates.splitCandidates[0];
  const group = candidate?.groupIds[0];
  if (!candidate || !group) throw new Error("fixture did not produce a declaration SCC");

  const result = await runIn(
    root,
    "prepare-plan",
    "--file",
    source,
    "--candidate",
    candidate.id,
    "--target",
    "apps/web/src/unresolved-import-fixture-types.ts",
    "--module-specifier",
    "./unresolved-import-fixture-types.ts",
    "--group",
    group,
  );
  expect(result.code).toBe(64);
  expect(result.stderr).toContain("could not resolve required relative type import");
}, 30_000);

test("seams refuses a missing candidate instead of selecting one implicitly", async () => {
  const root = committedWorkspace();
  const result = await runIn(root, "seams", "--file", "apps/web/src/widgets/chart.ts");
  expect(result.code).toBe(64);
  expect(result.stderr).toContain("--candidate <id> is required");
});

test("campaign init scans stable HEAD, creates exclusively, and status detects stale HEAD", async () => {
  const root = committedWorkspace();
  const campaignPath = ".monocarve/campaigns/initialized.json";
  const initialized = await runJsonIn<{ written: boolean; campaign: { baselineCommit: string; children: unknown[] } }>(
    root,
    "campaign",
    "init",
    "--campaign",
    campaignPath,
    "--id",
    "fixture-init",
    "--objective",
    "decompose the fixture",
    "--max-pairs",
    "2",
    "--write",
  );
  expect(initialized).toMatchObject({ written: true, campaign: { children: [] } });
  expect(initialized.campaign.baselineCommit).toBe(fixtureGit(root, "rev-parse", "HEAD"));

  const status = await runJsonIn<{ phase: string; staleHead: boolean }>(root, "campaign", "status", "--campaign", campaignPath);
  expect(status).toMatchObject({ phase: "needs-preparation-review", staleHead: false });

  const overwrite = await runIn(
    root,
    "campaign",
    "init",
    "--campaign",
    campaignPath,
    "--id",
    "fixture-init",
    "--objective",
    "decompose the fixture",
    "--max-pairs",
    "2",
    "--write",
  );
  expect(overwrite.code).not.toBe(0);
  expect(overwrite.stderr).toContain("without overwriting an existing file");

  writeFileSync(join(root, "README.md"), "changed\n");
  fixtureGit(root, "add", "README.md");
  fixtureGit(root, "commit", "-qm", "test: advance head");
  const stale = await runJsonIn<{ phase: string; canProceed: boolean; staleHead: boolean; expectedCommit: string; observedCommit: string }>(
    root,
    "campaign",
    "status",
    "--campaign",
    campaignPath,
  );
  expect(stale).toMatchObject({ phase: "stale-head", staleHead: true, canProceed: false });
  expect(stale.observedCommit).not.toBe(stale.expectedCommit);
}, 30_000);

test("campaign init requires an explicit bounded stop condition and native scan", async () => {
  const root = committedWorkspace();
  const missingStop = await runIn(root, "campaign", "init", "--campaign", ".monocarve/plans/init.json", "--id", "fixture", "--objective", "split fixture");
  expect(missingStop.code).toBe(64);
  expect(missingStop.stderr).toContain("--max-pairs <count> is required");
  const captured = await runIn(
    root,
    "campaign",
    "init",
    "--campaign",
    ".monocarve/plans/init.json",
    "--id",
    "fixture",
    "--objective",
    "split fixture",
    "--max-pairs",
    "1",
    "--graph",
    "web=stale.json",
  );
  expect(captured.code).toBe(64);
  expect(captured.stderr).toContain("refuses --graph");
});

test("campaign advance refuses captured graph evidence before it can masquerade as a fresh rescan", async () => {
  const root = committedWorkspace();
  const result = await runIn(root, "campaign", "advance", "--graph", "web=stale-report.json");
  expect(result.code).toBe(64);
  expect(result.stderr).toContain("refuses --graph");
});

test("campaign commands refuse a versioned source-tree ledger", async () => {
  const root = committedWorkspace();
  const result = await runIn(root, "campaign", "advance", "--campaign", "campaign.json");
  expect(result.code).toBe(64);
  expect(result.stderr).toContain("must live beneath configured campaignDir");
});

test("campaign init refuses a configured campaign directory that is not ignored", async () => {
  const root = committedWorkspace();
  const configPath = join(root, "monocarve.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  config.campaignDir = "plans";
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  fixtureGit(root, "add", "--", "monocarve.config.json");
  fixtureGit(root, "commit", "-qm", "test: configure versioned campaign state");

  const result = await runIn(
    root,
    "campaign",
    "init",
    "--campaign",
    "plans/campaign.json",
    "--id",
    "fixture",
    "--objective",
    "split fixture",
    "--max-pairs",
    "1",
    "--write",
  );
  expect(result).toMatchObject({ code: 64 });
  expect(result.stderr).toContain("must be git-ignored operational state");
});

test("campaign ledger CAS persistence preserves an intervening writer and a rename failure", () => {
  const root = committedWorkspace();
  const metrics = { modules: 1 };
  const ledger = createCampaignLedger({
    campaignId: "persistence",
    objective: "record one reviewed child",
    stopConditions: [],
    baselineCommit: "baseline",
    initialGraph: { metrics, digest: hashJson(metrics) },
  });
  const path = "campaign.json";
  const absolute = join(root, path);
  const initial = serializeCampaignLedger(ledger);
  writeFileSync(absolute, initial);
  const external = `${initial}\nexternal writer\n`;
  expect(() =>
    writeCampaignLedgerAtomically(root, path, initial, "replacement\n", {
      writeFile: (temporary, contents) => {
        writeFileSync(temporary, contents);
        writeFileSync(absolute, external);
      },
      rename: renameSync,
      remove: () => {},
    }),
  ).toThrow("changed while this command was gathering evidence");
  expect(readFileSync(absolute, "utf8")).toBe(external);

  writeFileSync(absolute, initial);
  expect(() =>
    writeCampaignLedgerAtomically(root, path, initial, "replacement\n", {
      writeFile: writeFileSync,
      rename: () => {
        throw new Error("rename failure");
      },
      remove: () => {},
    }),
  ).toThrow("could not atomically persist campaign ledger");
  expect(readFileSync(absolute, "utf8")).toBe(initial);

  expect(() =>
    writeCampaignLedgerAtomically(root, path, initial, "replacement\n", {
      writeFile: () => {
        throw new Error("write failure");
      },
      rename: () => {
        throw new Error("rename should not run");
      },
      remove: () => {},
    }),
  ).toThrow("could not atomically persist campaign ledger");
  expect(readFileSync(absolute, "utf8")).toBe(initial);
});

test("campaign ledger lock serializes mutation and init HEAD race publishes nothing", () => {
  const root = committedWorkspace();
  const metrics = { modules: 1 };
  const ledger = createCampaignLedger({
    campaignId: "race-proof",
    objective: "prove mutation boundaries",
    stopConditions: [],
    baselineCommit: "baseline",
    initialGraph: { metrics, digest: hashJson(metrics) },
  });
  const path = ".monocarve/plans/race.json";
  const absolute = join(root, path);
  mkdirSync(join(root, ".monocarve/plans"), { recursive: true });
  writeFileSync(`${absolute}.lock`, "other writer\n");
  expect(() => writeCampaignLedgerAtomically(root, path, "missing", "replacement\n")).toThrow("atomically persist");
  expect(existsSync(absolute)).toBe(false);
  expect(readFileSync(`${absolute}.lock`, "utf8")).toBe("other writer\n");

  // Remove only the synthetic lock; production never removes a lock it does not own.
  unlinkSync(`${absolute}.lock`);
  expect(() =>
    createCampaignLedgerFile(root, path, ledger, () => {
      throw new Error("HEAD changed");
    }),
  ).toThrow("HEAD changed");
  expect(existsSync(absolute)).toBe(false);
  expect(existsSync(`${absolute}.lock`)).toBe(false);
});

test("campaign ledger ownership transfer preserves replacements at both publication boundaries", () => {
  const root = committedWorkspace();
  const metrics = { modules: 1 };
  const ledger = createCampaignLedger({
    campaignId: "ownership",
    objective: "prove replacement preservation",
    stopConditions: [],
    baselineCommit: "baseline",
    initialGraph: { metrics, digest: hashJson(metrics) },
  });
  const path = ".monocarve/plans/ownership.json";
  const absolute = join(root, path);
  mkdirSync(join(root, ".monocarve/plans"), { recursive: true });
  const initial = serializeCampaignLedger(ledger);
  writeFileSync(absolute, initial);
  expect(() =>
    writeCampaignLedgerAtomically(root, path, initial, "updated\n", {
      writeFile: writeFileSync,
      rename: renameSync,
      remove: (file) => {
        if (existsSync(file)) unlinkSync(file);
      },
      afterOwnershipAcquired: () => writeFileSync(absolute, "concurrent replacement\n"),
    }),
  ).toThrow("replacement preserved");
  expect(readFileSync(absolute, "utf8")).toBe("concurrent replacement\n");
  expect(readdirSync(join(root, ".monocarve/plans")).some((name) => name.includes(".owned."))).toBe(true);

  unlinkSync(absolute);
  expect(() =>
    createCampaignLedgerFile(root, path, ledger, () => {
      renameSync(absolute, `${absolute}.published-by-init`);
      writeFileSync(absolute, "post-publication replacement\n");
      throw new Error("HEAD changed after publication");
    }),
  ).toThrow("concurrent replacement preserved");
  expect(readFileSync(absolute, "utf8")).toBe("post-publication replacement\n");
});
