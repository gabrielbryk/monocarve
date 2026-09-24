/**
 * The tool's own config facade (`monocarve/config`, alias `monocarve`) under
 * the assessment config sandbox: served from the running executable, never
 * walked into or captured from the workspace install. Type-only imports are
 * erased and neither walked nor executed. Every other boundary still holds.
 */
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as publicConfig from "../src/config.ts";
import { CONFIG_FACADE_EXPORTS, CONFIG_FACADE_SOURCE, configFacadeDigest } from "../src/config/config-facade.ts";
import { loadSnapshotConfig } from "../src/config/snapshot-loader.ts";
import { runIn } from "./support/cli.ts";
import { fixtureGit, scratchDirectory } from "./support/fixture-repo.ts";
import { sandboxAvailable, sandboxSkipReason } from "./support/sandbox.ts";

const USER_CONFIG = {
  applications: [{ name: "web", sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json" }],
  packageRoots: ["packages"],
  packageManager: "bun",
  scaffoldTemplates: { packageJson: { contents: '{"name":"{package}"}\n' } },
};

function config(source: string): { readonly root: string; readonly path: string } {
  const root = scratchDirectory();
  const path = join(root, "monocarve.config.ts");
  writeFileSync(path, source);
  return { root, path };
}

/** Without a sandbox every executable config fails closed before capture, on the missing-binary guard. */
function unbound(reason: string): string {
  return sandboxAvailable() ? `ASSESSMENT_CONFIG_UNBOUND: ${reason}` : "ASSESSMENT_CONFIG_UNBOUND";
}

/** An installed `monocarve` whose facade has dynamic imports and a non-identity defineConfig. */
function installPoisonedFacade(root: string): string {
  const packageRoot = join(root, "node_modules/monocarve");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), '{"name":"monocarve","type":"module","exports":{".":"./config.js","./config":"./config.js"}}\n');
  writeFileSync(
    join(packageRoot, "config.js"),
    'const name = "./x.js"; export const loader = () => import(name); export function defineConfig() { return { poisoned: true }; }\n',
  );
  return packageRoot;
}

test("the sandboxed facade provides only real, identity-preserving exports of the public config API", async () => {
  for (const name of CONFIG_FACADE_EXPORTS) expect(typeof Reflect.get(publicConfig, name)).toBe("function");
  const sample: publicConfig.MonocarveUserConfig = { applications: [], packageRoots: [], scaffoldTemplates: { packageJson: { contents: "{}" } } };
  expect(publicConfig.defineConfig(sample)).toBe(sample);
  const facade: unknown = await import(`data:text/javascript,${encodeURIComponent(CONFIG_FACADE_SOURCE)}`);
  if (typeof facade !== "object" || facade === null) throw new Error("facade did not evaluate to a module");
  expect(Object.keys(facade).toSorted()).toEqual([...CONFIG_FACADE_EXPORTS].toSorted());
  const defineConfig: unknown = Reflect.get(facade, "defineConfig");
  if (typeof defineConfig !== "function") throw new Error("facade defineConfig is not a function");
  const returned: unknown = Reflect.apply(defineConfig, undefined, [sample]);
  expect(returned).toBe(sample);
});

test.skipIf(!sandboxAvailable())(`a value import of defineConfig from the facade runs without binding the installed package (${sandboxSkipReason()})`, () => {
  const { root, path } = config(
    'import { defineConfig } from "monocarve/config"; import { defineConfig as root } from "monocarve"; export default root(defineConfig({ setting: 42 }));',
  );
  const packageRoot = installPoisonedFacade(root);
  const result = loadSnapshotConfig(path);
  expect(result.value).toEqual({ setting: 42 });
  expect(result.files.map((entry) => entry.path)).toEqual([path]);
  expect(result.files.some((entry) => entry.path.startsWith(packageRoot))).toBeFalse();
});

test.skipIf(!sandboxAvailable())(`a type-only facade import is erased, not walked or executed (${sandboxSkipReason()})`, () => {
  const { path } = config(
    [
      'import type { MonocarveConfig } from "monocarve/config";',
      'import { type MonocarveUserConfig } from "monocarve";',
      'export type { MonocarveConfig } from "monocarve/config";',
      'const value: MonocarveUserConfig = { root: "." } as MonocarveUserConfig;',
      "export default value as unknown as MonocarveConfig;",
    ].join("\n"),
  );
  // No `monocarve` is installed at all: a walk or a load would fail.
  expect(loadSnapshotConfig(path).value).toEqual({ root: "." });
});

test("importing another package with dynamic imports still fails closed", () => {
  const { root, path } = config(
    'import { defineConfig } from "monocarve/config"; import { setting } from "@acme/dynamic"; export default defineConfig({ setting });',
  );
  const packageRoot = join(root, "node_modules/@acme/dynamic");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), '{"name":"@acme/dynamic","type":"module","exports":"./index.js"}\n');
  writeFileSync(join(packageRoot, "index.js"), 'const name = "./x.js"; export const loader = () => import(name); export const setting = 1;\n');
  expect(() => loadSnapshotConfig(path)).toThrow(unbound("config inputs cannot be captured: config import cannot be inventoried"));
});

test("a type-only import does not hide a value import of the same package from the walk", () => {
  const { root, path } = config('import type { Loader } from "@acme/dynamic"; import { setting } from "@acme/dynamic"; export default { setting };');
  const packageRoot = join(root, "node_modules/@acme/dynamic");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), '{"name":"@acme/dynamic","type":"module","exports":"./index.js"}\n');
  writeFileSync(join(packageRoot, "index.js"), 'const name = "./x.js"; export const loader = () => import(name); export const setting = 1;\n');
  expect(() => loadSnapshotConfig(path)).toThrow(unbound("config inputs cannot be captured: config import cannot be inventoried"));
});

test("a config that imports the facade and reads an outside file still fails closed", () => {
  const { root, path } = config(
    'import { defineConfig } from "monocarve/config"; export default defineConfig({ value: await Bun.file("/etc/hostname").text() });',
  );
  installPoisonedFacade(root);
  expect(() => loadSnapshotConfig(path)).toThrow(unbound("config attempted a read outside captured inputs"));
});

test("a helper that imports the facade and reads an outside file still fails closed", () => {
  const { root, path } = config('import { value } from "./helper.ts"; export default { value };');
  writeFileSync(
    join(root, "helper.ts"),
    'import { defineConfig } from "monocarve/config";\nexport const value = defineConfig(await Bun.file("/etc/hostname").text());\n',
  );
  expect(() => loadSnapshotConfig(path)).toThrow(unbound("config attempted a read outside captured inputs"));
});

test.skipIf(!sandboxAvailable())(
  `assess accepts the documented defineConfig config and records the facade identity (${sandboxSkipReason()})`,
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
    writeFileSync(join(root, ".gitignore"), "node_modules\nevidence\n");
    writeFileSync(
      join(root, "monocarve.config.ts"),
      `import { defineConfig, type MonocarveUserConfig } from "monocarve/config";\nconst config: MonocarveUserConfig = ${JSON.stringify(USER_CONFIG)};\nexport default defineConfig(config);\n`,
    );
    installPoisonedFacade(root);
    fixtureGit(root, "init", "-q", "-b", "config-fixture");
    fixtureGit(root, "config", "user.email", "fixture@example.invalid");
    fixtureGit(root, "config", "user.name", "Fixture");
    fixtureGit(root, "add", ".");
    fixtureGit(root, "commit", "-qm", "fixture");
    const result = await runIn(root, "assess", "--app", "web", "--evidence-dir", "evidence", "--json");
    if (result.code !== 0) throw new Error(`assessment failed: ${result.stdout}\n${result.stderr}`);
    const manifest: unknown = JSON.parse(readFileSync(join(root, "evidence/manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ baseline: { runtime: { configFacade: configFacadeDigest() } } });
  },
  60_000,
);
