import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";

import { hashText } from "../src/util/hash.ts";
import { committedWorkspace, existsSync, readFileSync, runIn, runJsonIn, writeFileSync } from "./support/cli.ts";
import { cleanupFixtures, fixtureGit } from "./support/fixture-repo.ts";

afterAll(cleanupFixtures);

test("preparer lifecycle regenerates an RM-shaped source ledger exactly once and commits it causally", async () => {
  const root = committedWorkspace();
  const source = "apps/web/src/route-options.ts";
  const ledger = "generated/workers-port-ledger.json";
  writeFileSync(join(root, source), "export const routeOptions = 'old';\n");
  writeFileSync(join(root, ledger), '{"routeOptions":"old","runs":0}\n');
  writeFileSync(
    join(root, "scripts/generate-ledger.sh"),
    [
      "#!/bin/sh",
      "set -eu",
      "value=$(sed -n \"s/.*'\\([^']*\\)'.*/\\1/p\" apps/web/src/route-options.ts)",
      "runs=$(sed -n 's/.*\"runs\":\\([0-9]*\\).*/\\1/p' generated/workers-port-ledger.json)",
      "runs=$((runs + 1))",
      'printf \'{"routeOptions":"%s","runs":%s}\\n\' "$value" "$runs" > generated/workers-port-ledger.json',
      "",
    ].join("\n"),
  );
  fixtureGit(root, "add", "apps/web/src/route-options.ts", ledger, "scripts/generate-ledger.sh");
  fixtureGit(root, "commit", "-qm", "test: seed generated ledger");

  const configPath = join(root, "monocarve.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  config.preparers = [
    {
      id: "prepare-route-options",
      phase: "pre-extraction",
      outputs: [source],
      replacements: [{ path: source, prefix: "export const routeOptions = ", before: "'old'", after: "'new'", suffix: ";\n" }],
      commit: { subject: "refactor: prepare route options" },
    },
  ];
  config.generatedArtifacts = { artifacts: [{ path: ledger, source, regenerate: "sh scripts/generate-ledger.sh", triggers: ["^apps/web/src/"] }] };
  config.postJournalPreparers = [
    {
      id: "workers-port-ledger",
      phase: "after-journal-before-gates",
      command: "sh scripts/generate-ledger.sh",
      outputs: [ledger],
      triggers: ["^apps/web/src/"],
      verify: `grep -q '\"routeOptions\":\"new\"' ${ledger}`,
      emittedModuleSpecifiers: [],
    },
  ];
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  fixtureGit(root, "add", "monocarve.config.json");
  fixtureGit(root, "commit", "-qm", "test: configure RM-shaped preparer generation");

  const plan = await runJsonIn<{
    output: string;
    changedFiles: string[];
    generatedArtifacts: { regenerateOnApply: boolean }[];
    postJournalPreparers: { emittedModuleSpecifiers: unknown[] }[];
  }>(root, "preparer-plan", "--preparer", "prepare-route-options", "--source", source, "--write");
  expect(plan.changedFiles).toEqual([source, ledger].toSorted());
  expect(plan.generatedArtifacts).toEqual([expect.objectContaining({ regenerateOnApply: true })]);
  expect(plan.postJournalPreparers).toEqual([expect.objectContaining({ emittedModuleSpecifiers: [] })]);
  expect(await runJsonIn(root, "preparer-simulate", "--plan", plan.output)).toMatchObject({ ok: true });

  fixtureGit(root, "add", "-f", plan.output);
  fixtureGit(root, "commit", "-qm", "chore: approve generated preparer");
  expect(await runJsonIn(root, "preparer-apply", "--plan", plan.output)).toMatchObject({ ok: true });
  expect(readFileSync(join(root, ledger), "utf8")).toBe('{"routeOptions":"new","runs":1}\n');
  // The embedded counter proves the overlapping generated-artifact and
  // post-journal declaration executed one command, not two.
  const committed = await runJsonIn<{ commit: string }>(root, "preparer-commit", "--plan", plan.output);
  expect(committed.commit).toHaveLength(40);
  expect(fixtureGit(root, "show", "--format=", "--name-only", "HEAD").split("\n").toSorted()).toEqual([source, ledger].toSorted());
  expect(hashText(readFileSync(join(root, ledger), "utf8"))).toHaveLength(64);
}, 30_000);

test("preparer planning and apply fail closed for missing and stale generated output", async () => {
  const missingRoot = committedWorkspace();
  const configure = (root: string, command: string) => {
    const configPath = join(root, "monocarve.config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    config.preparers = [
      {
        id: "rewrite",
        phase: "pre-extraction",
        outputs: ["apps/web/src/types.ts"],
        replacements: [{ path: "apps/web/src/types.ts", before: "export interface Point {", after: "export interface Coordinate {", suffix: "\n  x: number;" }],
        commit: { subject: "refactor: rewrite types" },
      },
    ];
    config.generatedArtifacts = {
      artifacts: [{ path: "generated/ledger.txt", source: "apps/web/src/types.ts", regenerate: command, triggers: ["^apps/web/src/"] }],
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    fixtureGit(root, "add", "monocarve.config.json");
    fixtureGit(root, "commit", "-qm", "test: configure generator");
  };
  configure(missingRoot, "mkdir -p generated; rm -f generated/ledger.txt");
  const missing = await runIn(missingRoot, "preparer-plan", "--preparer", "rewrite", "--source", "apps/web/src/types.ts", "--json");
  expect(missing.code).not.toBe(0);
  expect(missing.stderr).toContain("produced no declared output");

  const staleRoot = committedWorkspace();
  configure(
    staleRoot,
    "mkdir -p generated; test ! -f stale-generator || printf stale > generated/ledger.txt; test -f stale-generator || printf current > generated/ledger.txt",
  );
  const plan = await runJsonIn<{ output: string }>(staleRoot, "preparer-plan", "--preparer", "rewrite", "--source", "apps/web/src/types.ts", "--write");
  fixtureGit(staleRoot, "add", "-f", plan.output);
  fixtureGit(staleRoot, "commit", "-qm", "chore: approve generated preparer");
  writeFileSync(join(staleRoot, "stale-generator"), "yes\n");
  const stale = await runIn(staleRoot, "preparer-apply", "--plan", plan.output);
  expect(stale.code).not.toBe(0);
  expect(stale.stderr).toContain("differs from reviewed result");
  expect(existsSync(join(staleRoot, "generated/ledger.txt"))).toBe(false);
}, 30_000);

test("terminal preparer reconciliation still triggers and commits only a stale generated ledger", async () => {
  const root = committedWorkspace();
  const configPath = join(root, "monocarve.config.json");
  const source = "apps/web/src/route-options.ts";
  const ledger = "generated/workers-port-ledger.json";
  writeFileSync(join(root, source), "export const routeOptions = 'old';\n");
  writeFileSync(join(root, ledger), "old ledger\n");
  const baseConfig = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  baseConfig.preparers = [
    {
      id: "prepare-route-options",
      phase: "pre-extraction",
      outputs: [source],
      replacements: [{ path: source, prefix: "export const routeOptions = ", before: "'old'", after: "'new'", suffix: ";\n" }],
      commit: { subject: "refactor: prepare route options" },
    },
  ];
  writeFileSync(configPath, `${JSON.stringify(baseConfig, null, 2)}\n`);
  fixtureGit(root, "add", configPath, source, ledger);
  fixtureGit(root, "commit", "-qm", "test: seed terminal reconciliation");

  const first = await runJsonIn<{ output: string }>(root, "preparer-plan", "--preparer", "prepare-route-options", "--source", source, "--write");
  fixtureGit(root, "add", "-f", first.output);
  fixtureGit(root, "commit", "-qm", "chore: approve source preparer");
  await runJsonIn(root, "preparer-apply", "--plan", first.output);
  await runJsonIn(root, "preparer-commit", "--plan", first.output);
  expect(readFileSync(join(root, source), "utf8")).toContain("'new'");
  expect(readFileSync(join(root, ledger), "utf8")).toBe("old ledger\n");

  const reconciledConfig = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  reconciledConfig.generatedArtifacts = {
    artifacts: [
      {
        path: ledger,
        source,
        regenerate: `printf 'current ledger\\n' > ${ledger}`,
        triggers: ["^apps/web/src/"],
        exemptReason: "terminal reconciliation fixture",
      },
    ],
  };
  writeFileSync(configPath, `${JSON.stringify(reconciledConfig, null, 2)}\n`);
  fixtureGit(root, "add", configPath);
  fixtureGit(root, "commit", "-qm", "test: configure ledger reconciliation");

  const second = await runJsonIn<{
    output: string;
    triggerPaths: string[];
    generatedArtifacts: { path: string }[];
    mutations: { path: string; preconditionHash: string; resultHash: string }[];
  }>(root, "preparer-plan", "--preparer", "prepare-route-options", "--source", source, "--write");
  expect(second.triggerPaths).toEqual([source]);
  expect(second.generatedArtifacts).toEqual([expect.objectContaining({ path: ledger })]);
  expect(second.mutations.find((item) => item.path === source)).toMatchObject({
    preconditionHash: second.mutations.find((item) => item.path === source)?.resultHash,
  });
  expect(second.mutations.find((item) => item.path === ledger)?.preconditionHash).not.toBe(second.mutations.find((item) => item.path === ledger)?.resultHash);
  expect(await runJsonIn(root, "preparer-simulate", "--plan", second.output)).toMatchObject({ ok: true });
  fixtureGit(root, "add", "-f", second.output);
  fixtureGit(root, "commit", "-qm", "chore: approve ledger reconciliation");
  expect(await runJsonIn(root, "preparer-apply", "--plan", second.output)).toMatchObject({ ok: true });
  await runJsonIn(root, "preparer-commit", "--plan", second.output);
  expect(fixtureGit(root, "show", "--format=", "--name-only", "HEAD")).toBe(ledger);
  expect(readFileSync(join(root, ledger), "utf8")).toBe("current ledger\n");
  expect(fixtureGit(root, "status", "--short")).toBe("");
}, 30_000);
