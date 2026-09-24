/**
 * Publication proof for the Bun-only distribution.
 *
 * A plausible but broken package can pass repository tests: npm may omit a
 * source entrypoint, or installed bins and exports may not resolve. This packs
 * the current tree, installs that exact tarball in a fresh consumer, and runs
 * the public root/config imports (which must expose the same surface) and every declared binary. It fails for each
 * of those concrete publication defects.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { sourceTreeIntegrity } from "../src/build-identity.ts";
import { buildSourceRevision } from "./build-stamp.ts";

interface PackageJson {
  readonly name: string;
  readonly bin?: string | Record<string, string>;
}

interface PackedFile {
  readonly path: string;
}

interface PackResult {
  readonly filename: string;
  readonly files: readonly PackedFile[];
}

function fail(message: string): never {
  throw new Error(`package verification failed: ${message}`);
}

function output(result: Bun.SyncSubprocess): string {
  const decoder = new TextDecoder();
  return decoder.decode(result.stderr).trim() || decoder.decode(result.stdout).trim();
}

function run(command: string, args: readonly string[], cwd: string): void {
  const result = Bun.spawnSync([command, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) fail(`${command} ${args.join(" ")} exited ${result.exitCode}: ${output(result)}`);
}

function sourceFiles(directory: string, root = directory): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path, root);
    return [relative(root, path).replaceAll("\\", "/")];
  });
}

function declaredBins(pkg: PackageJson): readonly [string, string][] {
  if (typeof pkg.bin === "string") return [[pkg.name, pkg.bin]];
  return Object.entries(pkg.bin ?? {});
}

const root = resolve(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageJson;
const bundledCli = readFileSync(join(root, "dist/monocarve.js"), "utf8");
const expectedIntegrity = sourceTreeIntegrity(join(root, "src"));
if (!bundledCli.includes(expectedIntegrity)) fail("bundled CLI omits the exact canonical source integrity stamp");
const expectedRevision = buildSourceRevision(root);
if (expectedRevision !== undefined && !bundledCli.includes(expectedRevision)) fail("bundled CLI omits the tool source revision stamp");
const cacheRoot = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "monocarve-package-verification");
mkdirSync(cacheRoot, { recursive: true });
const scratch = mkdtempSync(join(cacheRoot, "run-"));
let tarball: string | undefined;

try {
  const packed = Bun.spawnSync(["npm", "pack", "--json", "--ignore-scripts"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (packed.exitCode !== 0) fail(`npm pack exited ${packed.exitCode}: ${output(packed)}`);
  const reports = JSON.parse(new TextDecoder().decode(packed.stdout)) as readonly PackResult[];
  const report = reports[0];
  if (report === undefined) fail("npm pack returned no artifact");
  tarball = join(root, report.filename);
  if (!existsSync(tarball)) fail(`npm pack did not create ${report.filename}`);

  const packedPaths = new Set(report.files.map((file) => file.path));
  for (const required of [
    "package.json",
    "LICENSE",
    "README.md",
    "CHANGELOG.md",
    ...sourceFiles(join(root, "docs")).map((path) => `docs/${path}`),
    ...sourceFiles(join(root, "dist")).map((path) => `dist/${path}`),
  ]) {
    if (!packedPaths.has(required)) fail(`tarball omits required file ${required}`);
  }
  for (const path of packedPaths) {
    if (path.endsWith(".tsbuildinfo") || path.endsWith(".d.ts.map")) {
      fail(`tarball includes build-only metadata ${path}`);
    }
    if (
      path !== "package.json" &&
      path !== "LICENSE" &&
      path !== "README.md" &&
      path !== "CHANGELOG.md" &&
      !path.startsWith("dist/") &&
      !path.startsWith("docs/")
    ) {
      fail(`tarball includes unpublished path ${path}`);
    }
  }

  const consumer = join(scratch, "consumer");
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), `${JSON.stringify({ name: "package-verification-consumer", private: true, type: "module" })}\n`);
  run("bun", ["add", "--ignore-scripts", tarball], consumer);
  if (!existsSync(join(consumer, "node_modules", pkg.name))) {
    fail(`installed package is absent; consumer contains ${readdirSync(consumer).join(", ")}`);
  }

  writeFileSync(
    join(consumer, "probe.ts"),
    [
      `import * as root from ${JSON.stringify(pkg.name)};`,
      `import * as config from ${JSON.stringify(`${pkg.name}/config`)};`,
      `if (typeof root.defineConfig !== "function" || typeof config.defineConfig !== "function") throw new Error("public API unavailable");`,
      `const rootNames = Object.keys(root).sort().join(",");`,
      `if (rootNames !== Object.keys(config).sort().join(",")) throw new Error(\`root export diverges from ./config: \${rootNames}\`);`,
      "",
    ].join("\n"),
  );
  run("bun", ["run", "./probe.ts"], consumer);

  for (const [name, target] of declaredBins(pkg)) {
    if (!target.startsWith("./")) fail(`binary ${name} must use a package-relative target`);
    run(join(consumer, "node_modules", ".bin", name), ["--help"], consumer);
  }
} finally {
  if (tarball !== undefined) rmSync(tarball, { force: true });
  rmSync(scratch, { recursive: true, force: true });
}
