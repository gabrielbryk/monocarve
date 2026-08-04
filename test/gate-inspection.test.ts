import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { inspectGateEffects } from "../src/transaction/gate-inspection.ts";
import { cleanupFixtures, fixtureConfig, fixtureRepo } from "./support/fixture-repo.ts";
import { baseManifest, extractionFiles } from "./support/transaction-fixture.ts";

afterEach(cleanupFixtures);

test("attributes an undeclared gate output without touching the checkout", async () => {
  const root = fixtureRepo(extractionFiles());
  const config = fixtureConfig(root);
  const manifest = { ...baseManifest(root), gates: { package: [], project: [], workspace: ["mkdir -p reports && printf generated > reports/index.txt"] } };
  const report = await inspectGateEffects({ config, rootDir: root, manifest });
  expect(report.effects).toEqual([expect.objectContaining({ tier: "workspace", exitCode: 0, changedPaths: ["reports/index.txt"], undeclaredPaths: ["reports/index.txt"] })]);
  expect(report.effects[0]?.suggestedArtifacts[0]).toEqual({ path: "reports/index.txt", regenerate: manifest.gates.workspace[0]!, triggers: manifest.changedFiles });
  expect(existsSync(join(root, "reports/index.txt"))).toBe(false);
}, 30_000);

test("isolates every gate even when an earlier gate fails", async () => {
  const root = fixtureRepo(extractionFiles());
  const config = fixtureConfig(root);
  const manifest = { ...baseManifest(root), gates: { package: ["printf first > first.txt; exit 7", "test ! -e first.txt && printf second > second.txt"], project: [], workspace: [] } };
  const report = await inspectGateEffects({ config, rootDir: root, manifest });
  expect(report.effects.map((effect) => ({ command: effect.command, exitCode: effect.exitCode, changedPaths: effect.changedPaths }))).toEqual([
    { command: manifest.gates.package[0]!, exitCode: 7, changedPaths: ["first.txt"] },
    { command: manifest.gates.package[1]!, exitCode: 0, changedPaths: ["second.txt"] },
  ]);
  expect(report.effects[0]?.diagnostic?.command).toBe(manifest.gates.package[0]);
}, 30_000);
