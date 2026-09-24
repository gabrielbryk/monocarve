import { expect, test } from "bun:test";
import { cpSync, readFileSync, readdirSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { rawReportPaths } from "../src/assessment/bundle.ts";
import { captureInputInventory } from "../src/assessment/input-inventory.ts";
import { canonicalizeScanReport, containsAbsoluteReportPath } from "../src/assessment/report-paths.ts";
import { parseConfig } from "../src/config.ts";
import { stableStringify } from "../src/util/hash.ts";
import { runIn } from "./support/cli.ts";
import { fixtureRepo, scratchDirectory } from "./support/fixture-repo.ts";

test("raw scanner evidence canonicalizes absolute paths without leaking a checkout root", () => {
  const root = scratchDirectory();
  const report = {
    modules: [{ source: join(root, "apps/web/src/main.ts"), dependencies: [{ module: "./dep.ts", resolved: join(root, "apps/web/src/dep.ts") }] }],
    observedReads: [join(root, "apps/web/package.json"), join(root, "apps/web/src/main.ts"), "/machine-specific/secret/package.json"],
  };
  const canonical = canonicalizeScanReport(root, report);
  expect(canonical).toEqual({
    modules: [{ source: "apps/web/src/main.ts", dependencies: [{ module: "./dep.ts", resolved: "apps/web/src/dep.ts" }] }],
    observedReads: ["apps/web/package.json", "apps/web/src/main.ts", expect.stringMatching(/^external:/u)],
  });
  expect(containsAbsoluteReportPath(canonical)).toBeFalse();
});

test("raw scanner evidence keeps unnamed external paths with the same basename distinct", () => {
  const root = scratchDirectory();
  const firstRoot = scratchDirectory();
  const secondRoot = scratchDirectory();
  const first = join(firstRoot, "shared.d.ts");
  const second = join(secondRoot, "shared.d.ts");
  writeFileSync(first, "export type Shared = 1;\n");
  writeFileSync(second, "export type Shared = 1;\n");
  const canonical = canonicalizeScanReport(root, {
    modules: [
      { source: first, dependencies: [] },
      { source: second, dependencies: [] },
    ],
    observedReads: [first, second],
  });
  const sources = canonical.modules.map((module) => module.source);
  expect(new Set(sources).size).toBe(2);
  expect(sources.every((path) => path.startsWith("external:"))).toBeTrue();
  expect(containsAbsoluteReportPath(canonical)).toBeFalse();
  expect(JSON.stringify(canonical)).not.toContain(firstRoot);
  expect(JSON.stringify(canonical)).not.toContain(secondRoot);
});

test("published and replayed evidence never exposes an absolute external symlink target", async () => {
  const externalRoot = scratchDirectory();
  const external = join(externalRoot, "shared.ts");
  writeFileSync(external, "export const shared = 1;\n");
  const root = fixtureRepo({
    "apps/web/src/main.ts": 'export { shared } from "./shared.ts";\n',
    "apps/web/tsconfig.json":
      '{"compilerOptions":{"module":"esnext","moduleResolution":"bundler","allowImportingTsExtensions":true,"noEmit":true},"include":["src/**/*.ts"]}\n',
    "package.json": '{"private":true,"workspaces":[]}\n',
    "bun.lock": "{}\n",
    "packages/placeholder/package.json": '{"name":"@acme/placeholder","private":true}\n',
    "monocarve.config.json":
      JSON.stringify({
        applications: [{ name: "web", sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json" }],
        packageRoots: ["packages"],
        packageManager: "bun",
        testPathPatterns: ["\\.test\\.ts$"],
        scaffoldTemplates: { packageJson: { contents: '{"name":"{package}"}\n' } },
      }) + "\n",
  });
  symlinkSync(external, join(root, "apps/web/src/shared.ts"));
  const config = parseConfig(JSON.parse(readFileSync(join(root, "monocarve.config.json"), "utf8")));
  const inventory = captureInputInventory({ config, configPath: join(root, "monocarve.config.json"), rootDir: root });
  const serialized = JSON.stringify(inventory);
  expect(serialized).not.toContain(external);
  expect(serialized).not.toContain(externalRoot);
}, 60_000);

test("raw report paths remain deterministic and collision-free for arbitrary configured names", () => {
  const names = ["a/b", "a?b", "日本語 application", "__proto__"];
  const first = rawReportPaths(names);
  const second = rawReportPaths([...names].reverse());

  expect(first).toEqual(second);
  expect(Object.keys(first)).toEqual(["__proto__", "a/b", "a?b", "日本語 application"]);
  expect(new Set(Object.values(first)).size).toBe(names.length);
  expect(Object.values(first).every((path) => /^raw\/application-[0-9]+\.json$/u.test(path))).toBeTrue();
  expect(stableStringify(first)).toContain("__proto__");
});

test("assessment replay uses the manifest mapping for a filename-hostile application name", async () => {
  const application = "web/green?日本語";
  const root = fixtureRepo({
    "apps/web/src/main.ts": "export const main = 1;\n",
    "packages/placeholder/package.json": '{"name":"@acme/placeholder","private":true}\n',
    "apps/web/tsconfig.json":
      '{"compilerOptions":{"module":"esnext","moduleResolution":"bundler","allowImportingTsExtensions":true,"noEmit":true,"strict":true},"include":["src/**/*.ts"]}\n',
    "package.json": '{"private":true,"workspaces":[]}\n',
    "bun.lock": "{}\n",
    "monocarve.config.json": `${JSON.stringify({ applications: [{ name: application, sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json" }], packageRoots: ["packages"], packageManager: "bun", testPathPatterns: ["\\.test\\.ts$"], scaffoldTemplates: { packageJson: { contents: '{"name":"{package}"}\\n' } } })}\n`,
  });
  const live = await runIn(root, "assess", "--app", application, "--evidence-dir", "evidence", "--json");
  expect(live.code).toBe(0);
  const manifest = JSON.parse(readFileSync(join(root, "evidence/manifest.json"), "utf8")) as { rawReports: Record<string, string> };
  expect(manifest.rawReports[application]).toBe("raw/application-0.json");
  expect(readFileSync(join(root, "evidence/raw/application-0.json"), "utf8")).toContain("apps/web/src/main.ts");

  const replay = await runIn(root, "assess", "--app", application, "--evidence-dir", "replayed", "--replay", "evidence", "--json");
  expect(replay.code).toBe(0);
});

test("required raw evidence is byte-identical across checkout roots", async () => {
  const seed = fixtureRepo({
    "apps/web/src/main.ts": 'import { value } from "./value.ts"; export const main = value;\n',
    "apps/web/src/value.ts": "export const value = 1;\n",
    "apps/web/package.json": '{"name":"@acme/web","private":true}\n',
    "apps/web/tsconfig.json":
      '{"compilerOptions":{"module":"esnext","moduleResolution":"bundler","allowImportingTsExtensions":true,"noEmit":true},"include":["src/**/*.ts"]}\n',
    "package.json": '{"private":true,"workspaces":[]}\n',
    "bun.lock": "{}\n",
    "packages/placeholder/package.json": '{"name":"@acme/placeholder","private":true}\n',
    "monocarve.config.json":
      JSON.stringify({
        applications: [{ name: "web", sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json" }],
        packageRoots: ["packages"],
        packageManager: "bun",
        testPathPatterns: ["\\.test\\.ts$"],
        scaffoldTemplates: { packageJson: { contents: '{"name":"{package}"}\n' } },
      }) + "\n",
  });
  const first = join(scratchDirectory(), "checkout-a");
  const second = join(scratchDirectory(), "checkout-b");
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });
  cpSync(seed, first, { recursive: true });
  cpSync(seed, second, { recursive: true });

  for (const root of [first, second]) {
    const result = await runIn(root, "assess", "--app", "web", "--evidence-dir", "evidence", "--json");
    if (result.code !== 0) throw new Error(`${root}: ${result.stdout}\n${result.stderr}`);
    const raw = readFileSync(join(root, "evidence/raw/application-0.json"), "utf8");
    expect(raw).not.toContain(root);
    expect(containsAbsoluteReportPath(JSON.parse(raw))).toBeFalse();
  }
  expect(bundleFiles(first)).toEqual(bundleFiles(second));
}, 30_000);

function bundleFiles(root: string, current = join(root, "evidence")): Record<string, string> {
  return Object.fromEntries(
    readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
      const absolute = join(current, entry.name);
      return entry.isDirectory()
        ? Object.entries(bundleFiles(root, absolute))
        : [[absolute.slice(join(root, "evidence").length + 1), readFileSync(absolute, "base64")]];
    }),
  );
}
