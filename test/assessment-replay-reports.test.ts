import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { captureAssessmentSnapshot } from "../src/assessment/snapshot.ts";
import { loadConfig } from "../src/config.ts";
import { hashBytes } from "../src/util/hash.ts";
import { runIn } from "./support/cli.ts";
import { fixtureGit, scratchDirectory } from "./support/fixture-repo.ts";

function assessmentFixture(): string {
  const root = scratchDirectory();
  mkdirSync(join(root, "apps/web/src"), { recursive: true });
  mkdirSync(join(root, "packages"), { recursive: true });
  writeFileSync(join(root, "apps/web/src/main.ts"), 'import { value } from "./types.ts"; export const main = value;\n');
  writeFileSync(join(root, "apps/web/src/types.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "apps/web/package.json"), '{"name":"@acme/web","private":true}\n');
  writeFileSync(
    join(root, "apps/web/tsconfig.json"),
    '{"compilerOptions":{"module":"esnext","moduleResolution":"bundler","allowImportingTsExtensions":true,"noEmit":true,"strict":true},"include":["src/**/*.ts"]}\n',
  );
  writeFileSync(join(root, "package.json"), '{"private":true,"workspaces":[]}\n');
  writeFileSync(join(root, "bun.lock"), "{}\n");
  writeFileSync(
    join(root, "monocarve.config.json"),
    `${JSON.stringify({ applications: [{ name: "web", sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json" }], packageRoots: ["packages"], packageManager: "bun", testPathPatterns: ["\\\\.test\\\\.ts$"], scaffoldTemplates: { packageJson: { contents: '{"name":"{package}"}\\n' } } }, null, 2)}\n`,
  );
  fixtureGit(root, "init", "-q", "-b", "assessment-fixture");
  fixtureGit(root, "config", "user.email", "fixture@example.invalid");
  fixtureGit(root, "config", "user.name", "Fixture");
  fixtureGit(root, "add", ".");
  fixtureGit(root, "commit", "-qm", "fixture");
  return root;
}

function files(root: string, current = root): Record<string, string> {
  return Object.fromEntries(
    readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
      const absolute = join(current, entry.name);
      return entry.isDirectory() ? Object.entries(files(root, absolute)) : [[absolute.slice(root.length + 1), readFileSync(absolute, "base64")]];
    }),
  );
}

async function capture(root: string, evidence = "evidence") {
  const result = await runIn(root, "assess", "--app", "web", "--evidence-dir", evidence, "--json");
  if (result.code !== 0) throw new Error(`capture failed (${result.code}): ${result.stdout}\n${result.stderr}`);
  return result;
}

test("replay refuses modified artifacts and preserves the destination", async () => {
  const root = assessmentFixture();
  await capture(root);
  writeFileSync(join(root, "evidence/summary.json"), "{}\n");
  const result = await runIn(root, "assess", "--app", "web", "--evidence-dir", "replayed", "--replay", "evidence", "--json");
  expect(result.code).toBe(1);
  expect(result.stdout).toContain("ASSESSMENT_REPLAY_PROVENANCE_REQUIRED");
  expect(existsSync(join(root, "replayed"))).toBeFalse();
});

test("assessment and replay refuse filesystem-backed TS config before it executes", async () => {
  const root = assessmentFixture();
  await capture(root);
  const configPath = join(root, "monocarve.config.ts");
  const configDataPath = join(root, "config-data.json");
  const config = readFileSync(join(root, "monocarve.config.json"), "utf8");
  unlinkSync(join(root, "monocarve.config.json"));
  writeFileSync(configDataPath, config);
  writeFileSync(
    configPath,
    [
      'import { readFileSync, writeFileSync } from "node:fs";',
      'const value = JSON.parse(readFileSync(new URL("./config-data.json", import.meta.url), "utf8"));',
      'writeFileSync(new URL("./config-executed", import.meta.url), "yes");',
      "export default value;",
    ].join("\n"),
  );
  const assessment = await runIn(root, "assess", "--app", "web", "--evidence-dir", "new-evidence", "--json");
  expect(assessment.code).toBe(1);
  expect(assessment.stdout).toContain("ASSESSMENT_CONFIG_UNBOUND");
  expect(existsSync(join(root, "config-executed"))).toBeFalse();
  const batch = await runIn(root, "split-candidates", "--app", "web", "--evidence-dir", "batch-evidence", "--file", "apps/web/src/types.ts", "--json");
  expect(batch.code).toBe(1);
  expect(batch.stdout).toContain("ASSESSMENT_CONFIG_UNBOUND");
  expect(existsSync(join(root, "config-executed"))).toBeFalse();
  expect(existsSync(join(root, "batch-evidence"))).toBeFalse();
  const replay = await runIn(root, "assess", "--app", "web", "--evidence-dir", "replayed", "--replay", "evidence", "--json");
  expect(replay.code).toBe(1);
  expect(replay.stdout).toContain("ASSESSMENT_CONFIG_UNBOUND");
  expect(existsSync(join(root, "replayed"))).toBeFalse();
});

test("assessment, replay, and standalone batch refuse indirect ambient config reads", async () => {
  const root = assessmentFixture();
  await capture(root);
  unlinkSync(join(root, "monocarve.config.json"));
  writeFileSync(join(root, "monocarve.config.ts"), 'export default JSON.parse(await Bun.file("/etc/hostname").text());\n');
  for (const arguments_ of [
    ["assess", "--app", "web", "--evidence-dir", "new-evidence"],
    ["assess", "--app", "web", "--evidence-dir", "replayed", "--replay", "evidence"],
    ["split-candidates", "--app", "web", "--evidence-dir", "batch-evidence", "--file", "apps/web/src/types.ts"],
  ]) {
    const result = await runIn(root, ...arguments_, "--json");
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("ASSESSMENT_CONFIG_UNBOUND");
  }
  expect(existsSync(join(root, "new-evidence"))).toBeFalse();
  expect(existsSync(join(root, "replayed"))).toBeFalse();
  expect(existsSync(join(root, "batch-evidence"))).toBeFalse();
}, 60_000);

test("replay refuses a self-consistent promotion of degraded qualification", async () => {
  const root = assessmentFixture();
  writeFileSync(join(root, "package.json"), '{"private":true,"workspaces":["packages/*"]}\n');
  fixtureGit(root, "add", "package.json");
  fixtureGit(root, "commit", "-qm", "fixture workspace pattern");
  const captured = await runIn(root, "assess", "--app", "web", "--evidence-dir", "evidence", "--json");
  expect(captured.code).toBe(2);
  const manifestPath = join(root, "evidence/manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    qualification: Record<string, unknown>;
    artifacts: Array<{ path: string; bytes: number; sha256: string }>;
  };
  manifest.qualification = { schemaVersion: 1, status: "qualified", exitCode: 0, mayPublish: true, diagnostics: [], overrides: [] };
  const summaryPath = join(root, "evidence/summary.json");
  const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as { qualification: Record<string, unknown> };
  summary.qualification = manifest.qualification;
  const bytes = new TextEncoder().encode(`${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(summaryPath, bytes);
  const record = manifest.artifacts.find((entry) => entry.path === "summary.json")!;
  record.bytes = bytes.byteLength;
  record.sha256 = hashBytes(bytes);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const replay = await runIn(root, "assess", "--app", "web", "--evidence-dir", "replayed", "--replay", "evidence", "--json");
  expect(replay.code).toBe(1);
  expect(replay.stdout).toContain("ASSESSMENT_REPLAY_INPUT_MISMATCH");
  expect(existsSync(join(root, "replayed"))).toBeFalse();
}, 60_000);

test("replay binds raw report identity to the requested configured application", async () => {
  const root = assessmentFixture();
  await capture(root);
  const manifestPath = join(root, "evidence/manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { rawReports: Record<string, string> };
  const rawPath = manifest.rawReports.web!;
  manifest.rawReports = { "not-configured/application": rawPath };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const replay = await runIn(root, "assess", "--app", "web", "--evidence-dir", "replayed", "--replay", "evidence", "--json");
  expect(replay.code).toBe(1);
  expect(replay.stdout).toContain("ASSESSMENT_REPLAY_INPUT_MISMATCH");
  expect(replay.stdout).toContain("exactly the requested configured application");
  expect(existsSync(join(root, "replayed"))).toBeFalse();
});

test("replay refuses a raw scanner report whose module is outside captured authority", async () => {
  const root = assessmentFixture();
  await capture(root);
  const manifestPath = join(root, "evidence/manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    rawReports: Record<string, string>;
    artifacts: Array<{ path: string; bytes: number; sha256: string; required: boolean }>;
  };
  const rawPath = manifest.rawReports.web!;
  const absoluteRawPath = join(root, "evidence", rawPath);
  const report = JSON.parse(readFileSync(absoluteRawPath, "utf8")) as { modules: Array<{ source: string }> };
  report.modules[0]!.source = "apps/web/src/not-captured.ts";
  const rawBytes = new TextEncoder().encode(`${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(absoluteRawPath, rawBytes);
  const record = manifest.artifacts.find((entry) => entry.path === rawPath)!;
  record.bytes = rawBytes.byteLength;
  record.sha256 = hashBytes(rawBytes);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const replay = await runIn(root, "assess", "--app", "web", "--evidence-dir", "replayed", "--replay", "evidence", "--json");
  expect(replay.code).toBe(1);
  expect(replay.stdout).toContain("ASSESSMENT_INPUT_UNBOUND");
  expect(existsSync(join(root, "replayed"))).toBeFalse();
}, 30_000);

test("replay rejects executable/runtime identity mismatch and package drift", async () => {
  const executableRoot = assessmentFixture();
  await capture(executableRoot);
  const executableManifestPath = join(executableRoot, "evidence/manifest.json");
  const executableManifest = JSON.parse(readFileSync(executableManifestPath, "utf8")) as {
    baseline: { executable: { compiler: { artifactIntegrity: string } } };
  };
  executableManifest.baseline.executable.compiler.artifactIntegrity = "0".repeat(64);
  writeFileSync(executableManifestPath, `${JSON.stringify(executableManifest, null, 2)}\n`);
  const executableResult = await runIn(executableRoot, "assess", "--app", "web", "--evidence-dir", "replayed", "--replay", "evidence", "--json");
  expect(executableResult.code).toBe(1);
  expect(executableResult.stdout).toContain("ASSESSMENT_REPLAY_INPUT_MISMATCH");

  const runtimeRoot = assessmentFixture();
  await capture(runtimeRoot);
  const runtimeManifestPath = join(runtimeRoot, "evidence/manifest.json");
  const runtimeManifest = JSON.parse(readFileSync(runtimeManifestPath, "utf8")) as { baseline: { runtime: { node: string } } };
  runtimeManifest.baseline.runtime.node = "v0.0.0-test";
  writeFileSync(runtimeManifestPath, `${JSON.stringify(runtimeManifest, null, 2)}\n`);
  const runtimeResult = await runIn(runtimeRoot, "assess", "--app", "web", "--evidence-dir", "replayed", "--replay", "evidence", "--json");
  expect(runtimeResult.code).toBe(1);
  expect(runtimeResult.stdout).toContain("ASSESSMENT_REPLAY_INPUT_MISMATCH");

  const packageRoot = assessmentFixture();
  await capture(packageRoot);
  const packagePath = join(packageRoot, "apps/web/package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
  packageJson.drift = true;
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  const packageResult = await runIn(packageRoot, "assess", "--app", "web", "--evidence-dir", "replayed", "--replay", "evidence", "--json");
  expect(packageResult.code).toBe(1);
  expect(packageResult.stdout).toContain("ASSESSMENT_REPLAY_INPUT_MISMATCH");
}, 30_000);

test("bare graph replay is refused before any scan or output", async () => {
  const root = assessmentFixture();
  const result = await runIn(root, "assess", "--app", "web", "--evidence-dir", "evidence", "--graph", "web=graph.json", "--json");
  expect(result.code).toBe(64);
  expect(result.stderr).toContain("ASSESSMENT_REPLAY_PROVENANCE_REQUIRED");
  expect(existsSync(join(root, "evidence"))).toBeFalse();
});

test("source membership drift and stale graph facts fail closed", async () => {
  const root = assessmentFixture();
  await capture(root);
  writeFileSync(join(root, "apps/web/src/new-module.ts"), "export const added = true;\n");
  const added = await runIn(root, "assess", "--app", "web", "--evidence-dir", "added", "--replay", "evidence", "--json");
  expect(added.code).toBe(1);
  expect(added.stdout).toContain("ASSESSMENT_REPLAY_INPUT_MISMATCH");

  const config = await loadConfig({ cwd: root });
  const first = await captureAssessmentSnapshot({ ...config, application: "web" });
  const oldLines = first.graph.nodes.get("apps/web/src/main.ts")?.lineCount;
  writeFileSync(join(root, "apps/web/src/main.ts"), `${readFileSync(join(root, "apps/web/src/main.ts"), "utf8")}\nexport const cacheProbe = true;\n`);
  const second = await captureAssessmentSnapshot({ ...config, application: "web" });
  expect(second.inputInventory.digest).not.toBe(first.inputInventory.digest);
  expect(second.graph.nodes.get("apps/web/src/main.ts")?.lineCount).toBeGreaterThan(oldLines ?? 0);
}, 30_000);

test("live and replay analytical artifacts are byte-identical and findings are bounded evidence", async () => {
  const root = assessmentFixture();
  await capture(root);
  const replay = await runIn(root, "assess", "--app", "web", "--evidence-dir", "replayed", "--replay", "evidence", "--json");
  expect(replay.code).toBe(0);
  const live = files(join(root, "evidence"));
  const replayed = files(join(root, "replayed"));
  for (const [path, bytes] of Object.entries(live)) {
    if (path === "manifest.json") continue;
    expect(replayed[path]).toBe(bytes);
  }
  const findings = readFileSync(join(root, "evidence/findings.md"), "utf8");
  expect(findings).toContain("## Domains and cycles");
  expect(findings).toContain("## Hotspots");
  expect(findings).toContain("Full portfolio details omitted by default");
  expect(findings).toContain("--full-portfolio");
  expect(findings).toContain("--replay <bundle-directory>");
  expect(findings).toContain("did not mutate source");
  expect(findings).toContain("does not authorize package extraction");
  expect(findings).not.toContain("architecture approved");
  expect(findings).not.toContain("source was mutated");
}, 30_000);

test("repeated replay excludes only prior validated evidence bundles from input identity", async () => {
  const root = assessmentFixture();
  await capture(root, "evidence");
  const firstReplay = await runIn(root, "assess", "--app", "web", "--evidence-dir", "replayed", "--replay", "evidence", "--json");
  expect(firstReplay.code).toBe(0);
  const secondReplay = await runIn(root, "assess", "--app", "web", "--evidence-dir", "full", "--replay", "replayed", "--json");
  expect(secondReplay.code).toBe(0);
  const live = files(join(root, "evidence"));
  const final = files(join(root, "full"));
  for (const [path, bytes] of Object.entries(live)) {
    if (path === "manifest.json") continue;
    expect(final[path]).toBe(bytes);
  }
}, 30_000);
