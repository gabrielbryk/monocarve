import { describe, expect, test } from "bun:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs } from "../src/cli.ts";
import { parseConfig } from "../src/config.ts";
import { applicationOwner } from "../src/config/helpers.ts";
import { hashText, isFileState, MISSING } from "../src/util/hash.ts";
import { relativeWorkspacePath, workspacePath } from "../src/util/paths.ts";
import { renderTemplate, templatePlaceholders } from "../src/util/template.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "../fixtures/basic-monorepo");

describe("utilities", () => {
  test("hashes are stable and recognizable as file states", () => {
    const digest = hashText("chart");
    expect(digest).toBe(hashText("chart"));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(isFileState(digest)).toBe(true);
    expect(isFileState(MISSING)).toBe(true);
    expect(isFileState("nope")).toBe(false);
  });

  test("templates render known placeholders and refuse unknown ones", () => {
    expect(renderTemplate("refactor({package}): move into {packageRoot}", { package: "@acme/chart", packageRoot: "libs/chart" })).toBe(
      "refactor(@acme/chart): move into libs/chart",
    );
    expect(templatePlaceholders("{a} {b} {a}")).toEqual(["a", "b"]);
    expect(() => renderTemplate("{missing}", {})).toThrow(/unknown placeholder/);
  });

  test("workspace paths refuse anything that escapes the root", () => {
    expect(workspacePath(FIXTURE, "apps/web/src/main.ts")).toBe(join(FIXTURE, "apps/web/src/main.ts"));
    expect(relativeWorkspacePath(FIXTURE, join(FIXTURE, "libs/format/src/index.ts"))).toBe("libs/format/src/index.ts");
    expect(() => workspacePath(FIXTURE, "../outside.ts")).toThrow(/not workspace-relative/);
    expect(() => workspacePath(FIXTURE, "/etc/passwd")).toThrow(/not workspace-relative/);
    expect(() => relativeWorkspacePath(FIXTURE, "/etc/passwd")).toThrow(/escapes the workspace/);
    // `isAbsolute` is platform-aware: on Windows a drive-rooted argument must
    // not be joined under the workspace as though it were a relative path.
    if (process.platform === "win32") {
      expect(() => workspacePath(FIXTURE, "C:\\outside.ts")).toThrow(/not workspace-relative/);
    }
  });

  test("cli parses flags, values, repeats, and subcommands", () => {
    const args = parseArgs(["plan", "--candidate", "c-1", "--out=plans/plan.json", "--graph", "web=a.json", "--graph", "api=b.json", "-j", "extra"]);
    expect(args.command).toBe("plan");
    expect(args.flags.get("candidate")).toBe("c-1");
    expect(args.flags.get("out")).toBe("plans/plan.json");
    expect(args.flags.get("json")).toBe(true);
    expect(args.repeated.get("graph")).toEqual(["web=a.json", "api=b.json"]);
    expect(args.positionals).toEqual(["extra"]);
  });

  test("uses an explicit exact-root application owner when configured", () => {
    const config = parseConfig({
      applications: [{ name: "worker", sourceRoot: "apps/worker", ownerRoot: "apps/worker", tsconfig: "apps/worker/tsconfig.json" }],
      packageRoots: ["libs"],
      scaffoldTemplates: { packageJson: { contents: '{"name":"{package}"}\n' } },
    });
    expect(applicationOwner(config.applications[0]!)).toBe("apps/worker");
  });
});
