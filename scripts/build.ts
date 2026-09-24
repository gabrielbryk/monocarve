import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { BunPlugin } from "bun";
import { sourceTreeIntegrity } from "../src/build-identity.ts";
import { scannerReadPlugin } from "../src/graph/scanner-read-plugin.ts";
import { buildSourceRevision } from "./build-stamp.ts";

const root = resolve(import.meta.dir, "..");
const bundleOnly = process.argv.includes("--bundle-only");
const buildIntegrity = sourceTreeIntegrity(resolve(root, "src"));
const sourceRevision = buildSourceRevision(root);
const dependencyVersions = Object.fromEntries(
  ["dependency-cruiser", "typescript"].map((name) => {
    const manifest = JSON.parse(readFileSync(resolve(root, "node_modules", name, "package.json"), "utf8")) as { version: string };
    return [name, manifest.version];
  }),
);

rmSync(resolve(root, "dist"), { recursive: true, force: true });
if (!bundleOnly) rmSync(resolve(root, "artifacts"), { recursive: true, force: true });
mkdirSync(resolve(root, "dist"), { recursive: true });

const dependencyCruiserReporterPlugin: BunPlugin = {
  name: "bundle-dependency-cruiser-identity-reporter",
  setup(build) {
    build.onLoad({ filter: /dependency-cruiser\/src\/report\/index\.mjs$/ }, ({ path }) => {
      const source = readFileSync(path, "utf8");
      const dynamicFallback = `\t\tconst lModuleToImport = TYPE2MODULE.get(pOutputType) ?? "./identity.mjs";\n\t\tconst lModule = await import(lModuleToImport);\n\t\tlReturnValue = lModule.default;`;
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
            `\t\tconst lModuleToImport = TYPE2MODULE.get(pOutputType);\n\t\tif (lModuleToImport) {\n\t\t\tconst lModule = await import(lModuleToImport);\n\t\t\tlReturnValue = lModule.default;\n\t\t} else {\n\t\t\tlReturnValue = identityReporter;\n\t\t}`,
          ),
      };
    });
  },
};

await build({ entrypoints: ["src/config.ts"], outdir: "dist", naming: "[name].js" }, "dist-source");
await build(
  {
    entrypoints: ["src/monocarve.ts"],
    outdir: "dist",
    naming: { entry: "[name].[ext]", chunk: "chunks/[name]-[hash].[ext]", asset: "assets/[name]-[hash].[ext]" },
  },
  "dist-source",
);
run(["bun", "x", "tsc", "--project", "tsconfig.build.json"]);
chmodSync(resolve(root, "dist/monocarve.js"), 0o755);

if (!bundleOnly) {
  mkdirSync(resolve(root, "artifacts"), { recursive: true });
  await build(
    { entrypoints: ["src/monocarve.ts"], compile: { outfile: resolve(root, "artifacts/monocarve"), autoloadDotenv: false, autoloadBunfig: false } },
    "standalone-bun",
  );
}

async function build(overrides: Bun.BuildConfig, packagingMode: "dist-source" | "standalone-bun"): Promise<void> {
  const result = await Bun.build({
    target: "bun",
    format: "esm",
    sourcemap: "none",
    allowUnresolved: [""],
    external: ["enhanced-resolve/lib/createInnerCallback"],
    plugins: [dependencyCruiserReporterPlugin, scannerReadPlugin],
    root,
    ...overrides,
    define: {
      ...overrides.define,
      __MONOCARVE_BUILD_INTEGRITY__: JSON.stringify(buildIntegrity),
      __MONOCARVE_SOURCE_REVISION__: sourceRevision === undefined ? "undefined" : JSON.stringify(sourceRevision),
      __MONOCARVE_PACKAGING_MODE__: JSON.stringify(packagingMode),
      __MONOCARVE_DEPENDENCY_VERSIONS__: JSON.stringify(dependencyVersions),
    },
  });
  if (!result.success) throw new AggregateError(result.logs, "bundle failed");
}

function run(command: readonly string[]): void {
  const result = Bun.spawnSync(command, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`build command failed (${result.exitCode}): ${command.join(" ")}`);
}
