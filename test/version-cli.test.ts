import { expect, test } from "bun:test";

import { TOOL_VERSION } from "../src/branding.ts";
import { run } from "./support/cli.ts";

test("ordinary version remains compatible and verbose version exposes executable identity", async () => {
  const ordinary = await run("--version");
  expect(ordinary).toEqual({ code: 0, stdout: `monocarve ${TOOL_VERSION}\n`, stderr: "" });

  const verbose = await run("--version", "--verbose");
  expect(verbose.code).toBe(0);
  expect(verbose.stderr).toBe("");
  expect(JSON.parse(verbose.stdout)).toMatchObject({
    schemaVersion: 1,
    semanticVersion: TOOL_VERSION,
    packagingMode: "source",
    compiler: { artifactIntegrity: expect.stringMatching(/^[0-9a-f]{64}$/) },
  });
});
