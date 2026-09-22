import { describe, expect, test } from "bun:test";

import { assertPreparationPolicyMatches, parseConfig, renderPreparationPolicy } from "../src/config.ts";
import { ConfigError } from "../src/errors.ts";

const base = {
  applications: [{ name: "consumer", sourceRoot: "apps/consumer/src", tsconfig: "apps/consumer/tsconfig.json" }],
  packageRoots: ["packages"],
  scaffoldTemplates: { packageJson: { contents: "{}" } },
};

const input = { sourcePath: "apps/consumer/src/model.ts", targetPath: "apps/consumer/src/model-types.ts", targetModuleSpecifier: "./model-types.js" };

describe("preparation policy", () => {
  test("preserves legacy config loading but refuses to certify an omitted policy", () => {
    const config = parseConfig(base);

    expect(config.preparation).toEqual({});
    expect(() => renderPreparationPolicy(config, input)).toThrow("must configure commit.subject");
  });

  test("renders only configured repository gates and commit metadata deterministically", () => {
    const config = parseConfig({
      ...base,
      preparation: {
        commit: { subject: "chore: prepare {sourcePath}", body: "target={targetPath}" },
        gates: { workspace: ["verify {targetPath}", "check {sourcePath}"], project: [] },
      },
    });

    expect(renderPreparationPolicy(config, input)).toEqual({
      commit: { subject: "chore: prepare apps/consumer/src/model.ts", body: "target=apps/consumer/src/model-types.ts" },
      gates: { package: [], project: [], workspace: ["check apps/consumer/src/model.ts", "verify apps/consumer/src/model-types.ts"] },
    });
  });

  test("refuses an explicitly empty gate policy rather than certifying zero gates", () => {
    const config = parseConfig({
      ...base,
      preparation: { commit: { subject: "chore: prepare declarations" }, gates: { package: [], project: [], workspace: [] } },
    });

    expect(() => renderPreparationPolicy(config, input)).toThrow("refusing to certify zero gates");
  });

  test("rejects unsupported placeholders and duplicate rendered gates", () => {
    const unknown = parseConfig({ ...base, preparation: { commit: { subject: "chore: prepare {package}" }, gates: { workspace: ["verify"] } } });
    expect(() => renderPreparationPolicy(unknown, input)).toThrow("unsupported preparation placeholder");

    const duplicate = parseConfig({
      ...base,
      preparation: { commit: { subject: "chore: prepare declarations" }, gates: { workspace: ["verify {app}", "verify consumer"] } },
    });
    expect(() => renderPreparationPolicy(duplicate, input)).toThrow("renders duplicate commands");
  });

  test("detects a manifest policy that drops a configured gate or changes its commit", () => {
    const config = parseConfig({ ...base, preparation: { commit: { subject: "chore: prepare declarations" }, gates: { workspace: ["verify {sourcePath}"] } } });
    const rendered = renderPreparationPolicy(config, input);

    expect(() => assertPreparationPolicyMatches(config, input, { ...rendered, gates: { ...rendered.gates, workspace: [] } })).toThrow(ConfigError);
    expect(() => assertPreparationPolicyMatches(config, input, { ...rendered, commit: { subject: "chore: changed" } })).toThrow("policy differs");
  });
});
