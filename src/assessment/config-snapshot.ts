import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { bunAdapter } from "../adapters/bun.ts";
import { pnpmAdapter } from "../adapters/pnpm.ts";
import { ConfigError } from "../errors.ts";
import { byCodeUnit, hashBytes, type Sha256 } from "../util/hash.ts";
import { scratchRoot } from "../util/scratch-root.ts";
import { collectLocalConfigDependencies } from "./input-inventory.ts";

export interface ConfigSnapshotFile {
  readonly path: string;
  readonly sha256: Sha256;
  readonly size: number;
}

export interface ConfigSnapshotResult {
  readonly value: unknown;
  readonly files: readonly ConfigSnapshotFile[];
}

const WORKER = [
  'import { pathToFileURL } from "node:url";',
  'process.stderr.write("ASSESSMENT_CONFIG_EXEC_START\\n");',
  'const loaded = await import(pathToFileURL(process.argv[1]).href);',
  'if (loaded.default === undefined) throw new Error("config has no default export");',
  'process.stdout.write(JSON.stringify(loaded.default));',
].join("\n");

const SANDBOX_TMP = ".monocarve-config-tmp";

/** Run executable config against copied bytes, never the mutable checkout. */
export function loadSnapshotConfig(configPath: string, afterCapture?: () => void): ConfigSnapshotResult {
  const bwrap = "/usr/bin/bwrap";
  if (!existsSync(bwrap)) throw new ConfigError("ASSESSMENT_CONFIG_UNBOUND: executable config requires bwrap");
  if (!existsSync("/usr/bin/strace")) throw new ConfigError("ASSESSMENT_CONFIG_UNBOUND: executable config requires syscall read tracing");
  const binary = runtimeBinary();
  const runtime = runtimeLibraries(binary);
  const snapshot = mkdtempSync(join(scratchRoot(), "config-snapshot-"));
  const image = join(snapshot, "image");
  mkdirSync(image, { mode: 0o700 });
  // Private scratch lives outside /tmp: captured inputs keep their absolute
  // paths, and a workspace under /tmp must not be hidden by a tmpfs mount.
  mkdirSync(join(image, SANDBOX_TMP));
  mkdirSync(join(image, "proc"));
  mkdirSync(join(image, "dev"));
  try {
    let paths: string[];
    try { paths = configInputPaths(configPath); }
    catch (error) { throw new ConfigError(`ASSESSMENT_CONFIG_UNBOUND: config inputs cannot be captured: ${error instanceof Error ? error.message : String(error)}`); }
    const files = paths.map((path) => copyInput(image, path));
    afterCapture?.();
    // Bind targets must exist in the otherwise empty image. Runtime binaries
    // and libraries are trusted executable identity, not ambient host data.
    for (const path of ["/runtime/bun", ...runtime.map((entry) => entry.target)]) {
      const target = join(image, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "");
    }
    const command = [bwrap, "--unshare-all", "--die-with-parent", "--clearenv",
      "--setenv", "HOME", "/nonexistent", "--setenv", "TMPDIR", `/${SANDBOX_TMP}`,
      "--setenv", "PATH", "/runtime", "--ro-bind", image, "/",
      "--ro-bind", binary, "/runtime/bun",
      ...runtime.flatMap((entry) => ["--ro-bind", entry.source, entry.target]),
      "--tmpfs", `/${SANDBOX_TMP}`, "--proc", "/proc", "--dev", "/dev", "--chdir", dirname(configPath),
      "/runtime/bun", "--no-install", "-e", WORKER, configPath];
    const trace = join(snapshot, "reads.trace");
    const child = Bun.spawnSync({ cmd: ["/usr/bin/strace", "-f", "-qq", "-e", "trace=%file,write", "-o", trace, ...command], stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    const detail = new TextDecoder().decode(child.stderr).trim();
    assertNoFailedConfigReads(trace, detail);
    if (child.exitCode !== 0) {
      throw new ConfigError(`ASSESSMENT_CONFIG_UNBOUND: isolated config execution failed${detail ? `: ${detail}` : ""}`);
    }
    try { return { value: JSON.parse(new TextDecoder().decode(child.stdout)) as unknown, files }; }
    catch { throw new ConfigError("ASSESSMENT_CONFIG_UNBOUND: isolated config did not produce JSON"); }
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

function assertNoFailedConfigReads(trace: string, stderr: string): void {
  let output: string;
  try { output = readFileSync(trace, "utf8"); }
  catch { throw new ConfigError("ASSESSMENT_CONFIG_UNBOUND: config read trace is unavailable"); }
  const start = output.indexOf("ASSESSMENT_CONFIG_EXEC_START");
  if (start < 0) throw new ConfigError(`ASSESSMENT_CONFIG_UNBOUND: config execution trace is incomplete${stderr ? `: ${stderr}` : ""}`);
  const failed = output.slice(start).split("\n").find((line) =>
    /\b(?:open|openat|openat2|stat|statx|lstat|newfstatat|access|faccessat|faccessat2|readlink|readlinkat)\(/u.test(line) && !/\bO_WRONLY\b/u.test(line)
    && /= -1 (?:ENOENT|EACCES|EPERM)\b/u.test(line));
  if (failed) throw new ConfigError("ASSESSMENT_CONFIG_UNBOUND: config attempted a read outside captured inputs");
}

function configInputPaths(configPath: string): string[] {
  const root = dirname(configPath);
  const paths = new Set<string>();
  collectLocalConfigDependencies(configPath, (path) => {
    const absolute = resolve(path);
    if (!authorizedInput(root, absolute)) throw new ConfigError(`ASSESSMENT_CONFIG_UNBOUND: config import escapes workspace and installed dependencies: ${absolute}`);
    paths.add(absolute);
  });
  // These adapter-owned names are resolver inputs even before config has told
  // us which package manager applies.
  for (const name of ["package.json", bunAdapter.lockfileName, pnpmAdapter.lockfileName,
    bunAdapter.workspaceManifestName, pnpmAdapter.workspaceManifestName]) {
    if (name && existsSync(join(root, name))) paths.add(join(root, name));
  }
  for (const path of [...paths]) {
    let current = dirname(path);
    while (true) {
      const manifest = join(current, "package.json");
      if (existsSync(manifest) && authorizedInput(root, manifest)) paths.add(manifest);
      const parent = dirname(current);
      if (parent === current || current === root || !authorizedInput(root, parent)) break;
      current = parent;
    }
  }
  return [...paths].sort(byCodeUnit);
}

function authorizedInput(workspace: string, path: string): boolean {
  const absolute = resolve(path);
  if (within(workspace, absolute)) return within(workspace, realpathSync(absolute));
  let current = workspace;
  while (true) {
    const installed = join(current, "node_modules");
    if (within(installed, absolute)) return within(installed, realpathSync(absolute));
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}

function copyInput(image: string, path: string): ConfigSnapshotFile {
  const absolute = resolve(path);
  if (!isAbsolute(absolute) || !lstatSync(absolute).isFile()) throw new ConfigError(`ASSESSMENT_CONFIG_UNBOUND: config input is not a regular file: ${absolute}`);
  const bytes = readFileSync(absolute);
  const target = join(image, absolute);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes, { mode: 0o400 });
  return { path: absolute, sha256: hashBytes(bytes), size: bytes.byteLength };
}

function runtimeLibraries(binary: string): Array<{ readonly source: string; readonly target: string }> {
  const result = Bun.spawnSync({ cmd: ["ldd", binary], stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new ConfigError("ASSESSMENT_CONFIG_UNBOUND: cannot resolve Bun runtime libraries");
  const output = new TextDecoder().decode(result.stdout);
  const libraries = new Map<string, string>();
  for (const line of output.split("\n")) {
    const match = line.match(/(?:=>\s+)?(\/[^\s(]+)/u);
    if (match?.[1]) libraries.set(match[1], realpathSync(match[1]));
  }
  if (libraries.size === 0) throw new ConfigError("ASSESSMENT_CONFIG_UNBOUND: Bun runtime libraries were not identified");
  return [...libraries].map(([target, source]) => ({ source, target })).sort((a, b) => byCodeUnit(a.target, b.target));
}

function runtimeBinary(): string {
  if (basename(process.execPath) === "bun") return realpathSync(process.execPath);
  const probe = Bun.spawnSync({ cmd: ["bun", "-e", "process.stdout.write(process.execPath)"], stdout: "pipe", stderr: "pipe" });
  if (probe.exitCode !== 0) throw new ConfigError("ASSESSMENT_CONFIG_UNBOUND: Bun runtime is unavailable for isolated config execution");
  const binary = new TextDecoder().decode(probe.stdout).trim();
  if (!isAbsolute(binary)) throw new ConfigError("ASSESSMENT_CONFIG_UNBOUND: Bun runtime path is invalid");
  return realpathSync(binary);
}
