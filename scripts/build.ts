import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { BunPlugin } from "bun";
import { sourceTreeIntegrity } from "../src/build-identity.ts";
import { buildSourceRevision } from "./build-stamp.ts";

const root = resolve(import.meta.dir, "..");
const bundleOnly = process.argv.includes("--bundle-only");
const buildIntegrity = sourceTreeIntegrity(resolve(root, "src"));
const sourceRevision = buildSourceRevision(root);

rmSync(resolve(root, "dist"), { recursive: true, force: true });
if (!bundleOnly) rmSync(resolve(root, "artifacts"), { recursive: true, force: true });
mkdirSync(resolve(root, "dist"), { recursive: true });

const dependencyCruiserReporterPlugin: BunPlugin = {
  name: "bundle-dependency-cruiser-identity-reporter",
  setup(build) {
    build.onLoad({ filter: /dependency-cruiser\/src\/report\/index\.mjs$/ }, ({ path }) => {
      const source = readFileSync(path, "utf8");
      const dynamicFallback = `    const lModuleToImport = TYPE2MODULE.get(pOutputType) ?? "./identity.mjs";\n    const lModule = await import(lModuleToImport);\n    lReturnValue = lModule.default;`;
      if (!source.includes(dynamicFallback)) throw new Error("dependency-cruiser reporter integration changed; update the bundle adapter");
      return {
        loader: "js",
        contents: source
          .replace(
            `import { getExternalPluginReporter } from "./plugins.mjs";`,
            `import { getExternalPluginReporter } from "./plugins.mjs";\nimport identityReporter from "./identity.mjs";`,
          )
          .replace(
            dynamicFallback,
            `    const lModuleToImport = TYPE2MODULE.get(pOutputType);\n    if (lModuleToImport) {\n      const lModule = await import(lModuleToImport);\n      lReturnValue = lModule.default;\n    } else {\n      lReturnValue = identityReporter;\n    }`,
          ),
      };
    });
  },
};

await build({ entrypoints: ["src/index.ts", "src/config.ts"], outdir: "dist", naming: "[name].js" });
await build({ entrypoints: ["src/cli.ts"], outdir: "dist", naming: "monocarve.js" });
run(["bun", "x", "tsc", "--project", "tsconfig.build.json"]);
chmodSync(resolve(root, "dist/monocarve.js"), 0o755);

if (!bundleOnly) {
  mkdirSync(resolve(root, "artifacts"), { recursive: true });
  await build({
    entrypoints: ["src/cli.ts"],
    compile: { outfile: resolve(root, "artifacts/monocarve"), autoloadDotenv: false, autoloadBunfig: false },
  });
}

async function build(overrides: Bun.BuildConfig): Promise<void> {
  const result = await Bun.build({
    target: "bun",
    format: "esm",
    sourcemap: "none",
    allowUnresolved: [""],
    external: ["enhanced-resolve/lib/createInnerCallback"],
    plugins: [dependencyCruiserReporterPlugin],
    root,
    ...overrides,
    define: {
      ...overrides.define,
      __MONOCARVE_BUILD_INTEGRITY__: JSON.stringify(buildIntegrity),
      __MONOCARVE_SOURCE_REVISION__: sourceRevision === undefined ? "undefined" : JSON.stringify(sourceRevision),
    },
  });
  if (!result.success) throw new AggregateError(result.logs, "bundle failed");
}

function run(command: readonly string[]): void {
  const result = Bun.spawnSync(command, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`build command failed (${result.exitCode}): ${command.join(" ")}`);
}
