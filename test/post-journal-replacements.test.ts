import { afterEach, describe, expect, test } from "bun:test";

import type { ExtractionManifest } from "../src/plan/manifest.ts";
import { applyPlan } from "../src/transaction/apply.ts";
import { auditPlanSync } from "../src/transaction/audit.ts";
import { simulatePlan } from "../src/transaction/simulate.ts";
import { hashText } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureConfig, fixtureRepo, read } from "./support/fixture-repo.ts";
import { DONOR, TARGET, baseManifest, extractionFiles, landManifest } from "./support/transaction-fixture.ts";

describe("post-journal declarative edits", () => {
  afterEach(cleanupFixtures);

  test("replacements precede a command that imports the extracted target and are audited", async () => {
    const registry = 'export const modules = ["apps/api/src/widget/widget.ts"] as const;\n';
    const replaced = `export const modules = ["${TARGET}"] as const;\n`;
    const root = fixtureRepo({ ...extractionFiles(), "tools/module-registry.ts": registry });
    const command = `bun -e "import { widgetValue } from './${TARGET}'; await Bun.write('generated/value.txt', String(widgetValue))"`;
    const verify = `grep -q '${TARGET}' tools/module-registry.ts && test \"$(cat generated/value.txt)\" = 1`;
    const config = fixtureConfig(root, {
      postJournalPreparers: [
        {
          id: "module-registry",
          phase: "after-journal-before-gates",
          command,
          replacements: [
            {
              path: "tools/module-registry.ts",
              prefix: "export const modules = [",
              before: '"apps/api/src/widget/widget.ts"',
              after: `"${TARGET}"`,
              suffix: "] as const;\n",
            },
          ],
          outputs: ["tools/module-registry.ts", "generated/value.txt"],
          triggers: [`^${DONOR}$`],
          verify,
        },
      ],
    });
    const base = baseManifest(root);
    const manifest: ExtractionManifest = {
      ...base,
      postJournalPreparers: [
        {
          id: "module-registry",
          command,
          outputs: ["generated/value.txt", "tools/module-registry.ts"],
          replacements: [
            {
              path: "tools/module-registry.ts",
              prefix: "export const modules = [",
              before: '"apps/api/src/widget/widget.ts"',
              after: `"${TARGET}"`,
              suffix: "] as const;\n",
            },
          ],
          mutations: [
            {
              path: "tools/module-registry.ts",
              preconditionHash: hashText(registry),
              preconditionMode: 0o644,
              resultHash: hashText(replaced),
              resultMode: 0o644,
            },
          ],
          emittedModuleSpecifiers: [],
          verify,
        },
      ],
      generatedFiles: [
        {
          path: "generated/value.txt",
          source: TARGET,
          regenerate: command,
          regenerateOnApply: true,
          exemptReason: "fixture post-journal output",
          preparerId: "module-registry",
          verify,
        },
      ],
      changedFiles: [...base.changedFiles, "generated/value.txt", "tools/module-registry.ts"].toSorted(),
    };
    const simulation = await simulatePlan({ config, rootDir: root, manifest, skipGates: true });
    expect(simulation.failure).toBeUndefined();
    const manifestPath = landManifest(root, manifest);
    expect((await applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true })).ok).toBeTrue();
    expect(read(root, "tools/module-registry.ts")).toBe(replaced);
    expect(read(root, "generated/value.txt")).toBe("1");
    expect(auditPlanSync({ config, rootDir: root, manifest }).postJournalDeclarativeIntegrity!).toMatchObject({ passed: true });
  }, 120_000);

  test("manifest, missing-anchor, and ambiguous-anchor states fail closed", async () => {
    const registry = 'export const modules = ["old"] as const;\n';
    const root = fixtureRepo({ ...extractionFiles(), "tools/module-registry.ts": registry });
    const replacement = {
      path: "tools/module-registry.ts",
      prefix: "export const modules = [",
      before: '"old"',
      after: '"new"',
      suffix: "] as const;\n",
    } as const;
    const config = fixtureConfig(root, {
      postJournalPreparers: [
        { id: "module-registry", phase: "after-journal-before-gates", replacements: [replacement], outputs: ["tools/module-registry.ts"] },
      ],
    });
    const base = baseManifest(root);
    const record = {
      id: "module-registry",
      outputs: ["tools/module-registry.ts"],
      replacements: [replacement],
      mutations: [
        {
          path: "tools/module-registry.ts",
          preconditionHash: hashText(registry),
          preconditionMode: 0o644,
          resultHash: hashText('export const modules = ["new"] as const;\n'),
          resultMode: 0o644,
        },
      ],
      emittedModuleSpecifiers: [],
    } as const;
    const manifest: ExtractionManifest = { ...base, postJournalPreparers: [record], changedFiles: [...base.changedFiles, "tools/module-registry.ts"].toSorted() };
    const tampered: ExtractionManifest = { ...manifest, postJournalPreparers: [{ ...record, replacements: [{ ...replacement, after: '"other"' }] }] };
    expect((await simulatePlan({ config, rootDir: root, manifest: tampered, skipGates: true })).failure).toContain("differs from current configuration");
    const missingReplacement = { ...replacement, before: '"absent"' };
    const missingConfig = fixtureConfig(root, {
      postJournalPreparers: [
        { id: "module-registry", phase: "after-journal-before-gates", replacements: [missingReplacement], outputs: ["tools/module-registry.ts"] },
      ],
    });
    expect(
      (
        await simulatePlan({
          config: missingConfig,
          rootDir: root,
          manifest: { ...manifest, postJournalPreparers: [{ ...record, replacements: [missingReplacement] }] },
          skipGates: true,
        })
      ).failure,
    ).toContain("matched neither before nor after");

    const ambiguousText = 'export const first = ["old"]; export const second = ["old"];\n';
    const ambiguousRoot = fixtureRepo({ ...extractionFiles(), "tools/module-registry.ts": ambiguousText });
    const ambiguousReplacement = { path: "tools/module-registry.ts", prefix: "[", before: '"old"', after: '"new"', suffix: "]" } as const;
    const ambiguousConfig = fixtureConfig(ambiguousRoot, {
      postJournalPreparers: [
        { id: "module-registry", phase: "after-journal-before-gates", replacements: [ambiguousReplacement], outputs: ["tools/module-registry.ts"] },
      ],
    });
    const ambiguousBase = baseManifest(ambiguousRoot);
    const ambiguousRecord = {
      ...record,
      replacements: [ambiguousReplacement],
      mutations: [{ ...record.mutations[0], preconditionHash: hashText(ambiguousText) }],
    } as const;
    const ambiguousManifest: ExtractionManifest = {
      ...ambiguousBase,
      postJournalPreparers: [ambiguousRecord],
      changedFiles: [...ambiguousBase.changedFiles, "tools/module-registry.ts"].toSorted(),
    };
    expect((await simulatePlan({ config: ambiguousConfig, rootDir: ambiguousRoot, manifest: ambiguousManifest, skipGates: true })).failure).toContain(
      "before text is ambiguous",
    );
  }, 120_000);
});
