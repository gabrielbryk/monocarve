import { describe, expect, test } from "bun:test";

import { approvalGuidance } from "../src/commands/planning.ts";

const evidence = {
  manifestPath: "plans/example.json",
  baselineCommit: "baseline",
  branch: "feature",
  subject: "chore: approve extraction plan",
  gitAdd: ["git", "add", "--", "plans/example.json"] as const,
};

describe("printed approval workflow", () => {
  test("offers approval before the manifest is committed", () => {
    expect(approvalGuidance(evidence.manifestPath, evidence)).toMatchObject({
      approve: ["monocarve", "approve", "--plan", evidence.manifestPath, "--commit"],
      apply: ["monocarve", "apply", "--plan", evidence.manifestPath, "--commit"],
    });
  });

  test("does not offer approval again after --commit-approval", () => {
    const guidance = approvalGuidance(evidence.manifestPath, { ...evidence, commit: "approved" });
    expect(guidance).not.toHaveProperty("approve");
    expect(guidance).toMatchObject({
      commit: "approved",
      apply: ["monocarve", "apply", "--plan", evidence.manifestPath, "--commit"],
    });
  });
});
