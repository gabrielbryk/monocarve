import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadSnapshotConfig } from "../src/config/snapshot-loader.ts";
import { hashBytes } from "../src/util/hash.ts";
import { runIn } from "./support/cli.ts";
import { fixtureGit, scratchDirectory } from "./support/fixture-repo.ts";
import { sandboxAvailable, sandboxSkipReason } from "./support/sandbox.ts";

function config(source: string): { readonly root: string; readonly path: string } {
  const root = scratchDirectory();
  const path = join(root, "config.ts");
  writeFileSync(path, source);
  return { root, path };
}

test.skipIf(!sandboxAvailable())(`multi-file executable TS config imports a captured relative helper (${sandboxSkipReason()})`, () => {
  const { root, path } = config('import { setting } from "./helper.ts"; export default { setting };');
  writeFileSync(join(root, "helper.ts"), "export const setting: number = 42;\n");
  const result = loadSnapshotConfig(path);
  expect(result.value).toEqual({ setting: 42 });
  expect(result.files.map((entry) => entry.path)).toEqual([path, join(root, "helper.ts")]);
});

test.skipIf(!sandboxAvailable())(`executable TS config imports an installed package from captured metadata and bytes (${sandboxSkipReason()})`, () => {
  const { root, path } = config('import { setting } from "@acme/config"; export default { setting };');
  const packageRoot = join(root, "node_modules/@acme/config");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), '{"name":"@acme/config","type":"module","exports":"./index.js"}\n');
  writeFileSync(join(packageRoot, "index.js"), "export const setting = 42;\n");
  const result = loadSnapshotConfig(path);
  expect(result.value).toEqual({ setting: 42 });
  expect(result.files.map((entry) => entry.path)).toContain(join(packageRoot, "package.json"));
  expect(result.files.map((entry) => entry.path)).toContain(join(packageRoot, "index.js"));
});

test("Bun.file cannot read an ambient host file", () => {
  const { root, path } = config('export default { value: await Bun.file("/etc/hostname").text() };');
  expect(() => loadSnapshotConfig(path)).toThrow("ASSESSMENT_CONFIG_UNBOUND");
  expect(readFileSync(path, "utf8")).toContain("Bun.file");
  expect(root).toBeTruthy();
});

test("an arbitrary external static import cannot be captured as a dependency", () => {
  const outside = scratchDirectory();
  writeFileSync(join(outside, "value.ts"), "export const value = 42;\n");
  const { path } = config(`import { value } from ${JSON.stringify(join(outside, "value.ts"))}; export default { value };`);
  expect(() => loadSnapshotConfig(path)).toThrow("ASSESSMENT_CONFIG_UNBOUND");
});

test("a caught ambient read still invalidates config authority", () => {
  const { path } = config('let value = "fallback"; try { value = await Bun.file("/etc/hostname").text() } catch {} export default { value };');
  expect(() => loadSnapshotConfig(path)).toThrow("ASSESSMENT_CONFIG_UNBOUND");
});

test("a caught exists probe outside the captured set invalidates authority", () => {
  const { path } = config(
    'const fs = process.getBuiltinModule("node:fs"); let exists = false; try { exists = fs.existsSync("/etc/hostname") } catch {} export default { exists };',
  );
  expect(() => loadSnapshotConfig(path)).toThrow("ASSESSMENT_CONFIG_UNBOUND");
});

test("process.getBuiltinModule filesystem read cannot reach an ambient host file", () => {
  const { path } = config('const fs = process.getBuiltinModule("node:fs"); export default { value: fs.readFileSync("/etc/hostname", "utf8") };');
  expect(() => loadSnapshotConfig(path)).toThrow("ASSESSMENT_CONFIG_UNBOUND");
});

test("imported helper filesystem read outside captured inputs is refused", () => {
  const { root, path } = config('import { value } from "./helper.ts"; export default { value };');
  writeFileSync(join(root, "helper.ts"), 'export const value = await Bun.file("/etc/hostname").text();\n');
  expect(() => loadSnapshotConfig(path)).toThrow("ASSESSMENT_CONFIG_UNBOUND");
});

test("fetch file URL outside captured inputs is refused", () => {
  const { path } = config('export default { value: await (await fetch("file:///etc/hostname")).text() };');
  expect(() => loadSnapshotConfig(path)).toThrow("ASSESSMENT_CONFIG_UNBOUND");
});

test.skipIf(!sandboxAvailable())(`change and restore during execution cannot change captured helper bytes (${sandboxSkipReason()})`, () => {
  const { root, path } = config('import { setting } from "./helper.ts"; export default { setting };');
  const helper = join(root, "helper.ts");
  const original = "export const setting = 42;\n";
  writeFileSync(helper, original);
  const result = loadSnapshotConfig(path, () => {
    writeFileSync(helper, "export const setting = 99;\n");
    writeFileSync(helper, original);
  });
  expect(result.value).toEqual({ setting: 42 });
  expect(result.files.find((entry) => entry.path === helper)?.sha256).toBe(hashBytes(new TextEncoder().encode(original)));
});

test("snapshot does not allow config writes into the workspace", () => {
  const { root, path } = config('const fs = process.getBuiltinModule("node:fs"); fs.writeFileSync("write-attempt", "x"); export default {};');
  expect(() => loadSnapshotConfig(path)).toThrow("ASSESSMENT_CONFIG_UNBOUND");
  expect(existsSync(join(root, "write-attempt"))).toBeFalse();
});

test.skipIf(!sandboxAvailable())(
  `assessment CLI accepts a TS config with an imported helper and binds its bytes (${sandboxSkipReason()})`,
  async () => {
    const root = scratchDirectory();
    mkdirSync(join(root, "apps/web/src"), { recursive: true });
    mkdirSync(join(root, "packages"));
    writeFileSync(join(root, "apps/web/src/main.ts"), "export const main = 1;\n");
    writeFileSync(
      join(root, "apps/web/tsconfig.json"),
      '{"compilerOptions":{"module":"esnext","moduleResolution":"bundler","noEmit":true},"include":["src/**/*.ts"]}\n',
    );
    writeFileSync(join(root, "package.json"), '{"private":true,"workspaces":[]}\n');
    writeFileSync(join(root, "bun.lock"), "{}\n");
    writeFileSync(
      join(root, "monocarve.config.json"),
      JSON.stringify({
        applications: [{ name: "web", sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json" }],
        packageRoots: ["packages"],
        packageManager: "bun",
        scaffoldTemplates: { packageJson: { contents: '{"name":"{package}"}\n' } },
      }),
    );
    const helper = join(root, "config-helper.ts");
    writeFileSync(helper, 'import config from "./monocarve.config.json"; export default config;\n');
    writeFileSync(join(root, "monocarve.config.ts"), 'import config from "./config-helper.ts"; export default config;\n');
    fixtureGit(root, "init", "-q", "-b", "config-fixture");
    fixtureGit(root, "config", "user.email", "fixture@example.invalid");
    fixtureGit(root, "config", "user.name", "Fixture");
    fixtureGit(root, "add", ".");
    fixtureGit(root, "commit", "-qm", "fixture");
    const result = await runIn(root, "assess", "--app", "web", "--evidence-dir", "evidence", "--json");
    if (result.code !== 0) throw new Error(`assessment failed: ${result.stdout}\n${result.stderr}`);
    expect(result.code).toBe(0);
    const inventory = JSON.parse(readFileSync(join(root, "evidence/input-inventory.json"), "utf8")) as { entries: Array<{ path: string; sha256: string }> };
    expect(inventory.entries.some((entry) => entry.path === "config-helper.ts" && entry.sha256 === hashBytes(readFileSync(helper)))).toBeTrue();
  },
  60_000,
);

test("a concurrent outside read that strace splits across threads still invalidates authority", () => {
  // A background fs read overlapping main-thread file calls is logged as an
  // `<unfinished ...>` / `<... resumed>` pair; its failure is on the second line.
  const { root, path } = config(
    [
      'import { promises as fsp, statSync } from "node:fs";',
      'const own = import.meta.dir + "/package.json";',
      'let done = false; let code = "pending";',
      'fsp.readFile("/nonexistent-monocarve-probe/secret").then(() => { code = "hit"; }, (error) => { code = error.code; }).finally(() => { done = true; });',
      "let spins = 0;",
      "while (!done && spins < 200000) { statSync(own); spins++; if (spins % 50 === 0) await Promise.resolve(); if (spins % 500 === 0) await new Promise((resolve) => setImmediate(resolve)); }",
      "export default { code };",
    ].join("\n"),
  );
  writeFileSync(join(root, "package.json"), '{"name":"probe","type":"module"}\n');
  expect(() => loadSnapshotConfig(path)).toThrow("ASSESSMENT_CONFIG_UNBOUND");
});

test("a failed outside statfs invalidates authority", () => {
  const { path } = config(
    'const fs = process.getBuiltinModule("node:fs"); let ok = true; try { fs.statfsSync("/nonexistent-monocarve-probe") } catch { ok = false } export default { ok };',
  );
  expect(() => loadSnapshotConfig(path)).toThrow("ASSESSMENT_CONFIG_UNBOUND");
});

test.skipIf(!sandboxAvailable())(`a builtin imported without the node: prefix is not captured as a file (${sandboxSkipReason()})`, () => {
  const { path } = config('import { join } from "path"; export default { value: join("a", "b") };');
  expect(loadSnapshotConfig(path).value).toEqual({ value: "a/b" });
});
