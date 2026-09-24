import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { hashBytes } from "../src/util/hash.ts";
import { runIn } from "./support/cli.ts";
import { fixtureGit, scratchDirectory } from "./support/fixture-repo.ts";

test("live and replay assessment publish deterministic same-baseline evidence and reject consumer drift", async () => {
  const root = assessmentFixture();
  const live = await runIn(root, "assess", "--app", "web", "--evidence-dir", "evidence", "--json");
  expect(live.code).toBe(0);
  const before = bundleBytes(join(root, "evidence"));
  const replacement = await runIn(root, "assess", "--app", "web", "--evidence-dir", "evidence", "--replace-generated", "--json");
  expect(replacement.code).toBe(0);
  expect(bundleBytes(join(root, "evidence"))).toEqual(before);
  const replay = await runIn(root, "assess", "--app", "web", "--evidence-dir", "replayed", "--replay", "evidence", "--json");
  expect(replay.code).toBe(0);
  const liveSummary = JSON.parse(readFileSync(join(root, "evidence/summary.json"), "utf8")) as { graph: unknown };
  const replaySummary = JSON.parse(readFileSync(join(root, "replayed/summary.json"), "utf8")) as { graph: unknown };
  expect(replaySummary.graph).toEqual(liveSummary.graph);
  const replayManifest = JSON.parse(readFileSync(join(root, "replayed/manifest.json"), "utf8")) as { provenance: unknown };
  expect(replayManifest.provenance).toEqual({ capture: "live", invocation: "replay" });
  const full = await runIn(root, "assess", "--app", "web", "--evidence-dir", "full", "--replay", "evidence", "--full-portfolio", "--json");
  expect(full.code).toBe(0);
  const fullManifest = JSON.parse(readFileSync(join(root, "full/manifest.json"), "utf8")) as {
    artifacts: { path: string; sha256: string; required: boolean }[];
    omissions: unknown[];
  };
  expect(fullManifest.omissions).toEqual([]);
  expect(fullManifest.artifacts).toContainEqual(expect.objectContaining({ path: "input-inventory.json", required: true }));
  expect(fullManifest.artifacts.some((entry) => entry.path.startsWith("raw/") && entry.required)).toBeTrue();
  expect(fullManifest.artifacts).toContainEqual(expect.objectContaining({ path: "portfolio-full.json", required: false }));
  for (const artifact of fullManifest.artifacts) expect(hashBytes(readFileSync(join(root, "full", artifact.path)))).toBe(artifact.sha256);
  writeFileSync(join(root, "apps/web/src/consumer.ts"), 'import { shared } from "./shared.ts"; export const result = shared + 2;\n');
  const drift = await runIn(root, "assess", "--app", "web", "--evidence-dir", "drifted", "--replay", "evidence", "--allow-empty", "--json");
  expect(drift.code).toBe(1);
  expect(drift.stdout).toContain("ASSESSMENT_REPLAY_INPUT_MISMATCH");
}, 30_000);

test("truncated report recipes include an executable evidence destination", async () => {
  const root = assessmentFixture();
  writeFileSync(join(root, "apps/web/src/cycle-c.ts"), 'import { d } from "./cycle-d.ts"; export function c(): number { return d(); }\n');
  writeFileSync(join(root, "apps/web/src/cycle-d.ts"), 'import { c } from "./cycle-c.ts"; export function d(): number { return c(); }\n');
  writeFileSync(join(root, "apps/web/src/blocked-a.ts"), 'const target = "./shared.ts"; export const blockedA = import(target);\n');
  writeFileSync(join(root, "apps/web/src/blocked-b.ts"), 'const target = "./shared.ts"; export const blockedB = import(target);\n');
  const result = await runIn(root, "assess", "--app", "web", "--evidence-dir", "bounded", "--limit", "1", "--json");
  expect(result.code).toBe(0);
  const findings = readFileSync(join(root, "bounded/findings.md"), "utf8");
  for (const name of ["hotspots", "backlog"] as const) {
    const report = (
      JSON.parse(readFileSync(join(root, `bounded/${name}.json`), "utf8")) as {
        result: { status: string; value: { truncated: boolean; deeperCommand: string } };
      }
    ).result;
    expect(report.status).toBe("available");
    expect(report.value.truncated).toBeTrue();
    expect(report.value.deeperCommand).toContain("--evidence-dir <path>");
    expect(findings).toContain(report.value.deeperCommand);
    const deeper = report.value.deeperCommand.replace("<path>", `${name}-deeper`).split(" ");
    const executed = await runIn(root, ...deeper);
    expect(executed.code, `${executed.stdout}\n${executed.stderr}`).toBe(0);
    expect(existsSync(join(root, `${name}-deeper/manifest.json`))).toBeTrue();
  }
}, 60_000);

test("explicit declaration batch reuses one complete program and collision-safe names", async () => {
  const root = assessmentFixture();
  const result = await runIn(
    root,
    "split-candidates",
    "--app",
    "web",
    "--evidence-dir",
    "splits",
    "--file",
    "apps/web/src/alpha/model.ts",
    "--file",
    "apps/web/src/beta/model.ts",
    "--file",
    "apps/web/src/alpha/model.ts",
    "--json",
  );
  expect(result.code).toBe(0);
  const aggregate = JSON.parse(result.stdout) as { selection: { deduplicated: number }; entries: { reportPath: string }[] };
  expect(aggregate.selection.deduplicated).toBe(1);
  expect(new Set(aggregate.entries.map((entry) => entry.reportPath)).size).toBe(2);
  expect(aggregate.entries.every((entry) => entry.reportPath.startsWith("splits/") && entry.reportPath.endsWith(".json"))).toBeTrue();
}, 15_000);

test("batch program includes configured consumers outside the application tsconfig and protects their roots", async () => {
  const root = assessmentFixture();
  const configPath = join(root, "monocarve.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { applications: [{ consumerRoots?: string[] }]; firstPartyRoots?: string[] };
  config.applications[0].consumerRoots = ["apps/web/consumers"];
  config.firstPartyRoots = ["shared"];
  mkdirSync(join(root, "apps/web/consumers"), { recursive: true });
  mkdirSync(join(root, "shared"), { recursive: true });
  writeFileSync(join(root, "apps/web/consumers/check.ts"), 'import { alpha } from "../src/alpha/model.ts"; export const checked = alpha;\n');
  writeFileSync(join(root, "shared/marker.ts"), 'import { alpha } from "../apps/web/src/alpha/model.ts"; export const marker = alpha;\n');
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const batch = await runIn(root, "split-candidates", "--app", "web", "--evidence-dir", "splits", "--file", "apps/web/src/alpha/model.ts", "--json");
  expect(batch.code).toBe(0);
  const aggregate = JSON.parse(batch.stdout) as { entries: { reportPath: string }[] };
  const artifact = JSON.parse(readFileSync(join(root, "splits", aggregate.entries[0]!.reportPath), "utf8")) as {
    report: { consumers: { consumerPath: string }[] };
  };
  const report = artifact.report;
  expect(report.consumers.some((consumer) => consumer.consumerPath === "apps/web/consumers/check.ts")).toBeTrue();
  expect(report.consumers.some((consumer) => consumer.consumerPath === "shared/marker.ts")).toBeTrue();

  const overlap = await runIn(root, "assess", "--app", "web", "--evidence-dir", "apps/web/consumers", "--json");
  expect(overlap.code).toBe(1);
  expect(overlap.stdout).toContain("EVIDENCE_DESTINATION_UNSAFE");
}, 20_000);

test("live degraded and allowed-empty assessment outcomes publish explicit exit-two bundles", async () => {
  const degradedRoot = assessmentFixture();
  writeFileSync(join(degradedRoot, "package.json"), '{"private":true,"workspaces":["packages/*","plugins/*"]}\n');
  const degraded = await runIn(degradedRoot, "assess", "--app", "web", "--evidence-dir", "evidence", "--json");
  expect(degraded.code).toBe(2);
  expect(JSON.parse(degraded.stdout)).toMatchObject({ status: "degraded", exitCode: 2, published: true });
  const degradedManifest = JSON.parse(readFileSync(join(degradedRoot, "evidence/manifest.json"), "utf8")) as { qualification: unknown };
  expect(degradedManifest.qualification).toMatchObject({ status: "degraded", exitCode: 2, diagnostics: [{ code: "WORKSPACE_PATTERN_UNMATCHED" }] });

  const emptyRoot = assessmentFixture();
  rmSync(join(emptyRoot, "apps/web/src"), { recursive: true });
  mkdirSync(join(emptyRoot, "apps/web/src"), { recursive: true });
  writeFileSync(join(emptyRoot, "package.json"), '{"private":true,"workspaces":["packages/*","plugins/*"]}\n');
  const allowedEmpty = await runIn(emptyRoot, "assess", "--app", "web", "--evidence-dir", "evidence", "--allow-empty", "--json");
  expect(allowedEmpty.code).toBe(2);
  expect(JSON.parse(allowedEmpty.stdout)).toMatchObject({ status: "degraded", exitCode: 2, published: true });
  const emptyManifest = JSON.parse(readFileSync(join(emptyRoot, "evidence/manifest.json"), "utf8")) as { qualification: unknown; overrides: unknown };
  expect(emptyManifest).toMatchObject({ qualification: { status: "degraded", exitCode: 2 }, overrides: ["allow-empty"] });
}, 30_000);

test("allowed-empty findings use the configured application in every reproduction command", async () => {
  const root = assessmentFixture();
  rmSync(join(root, "apps/web/src"), { recursive: true });
  mkdirSync(join(root, "apps/web/src"), { recursive: true });
  const result = await runIn(root, "assess", "--app", "web", "--evidence-dir", "evidence", "--allow-empty", "--json");
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "allowed-empty", exitCode: 0, published: true });
  const findings = readFileSync(join(root, "evidence/findings.md"), "utf8");
  const commands = findings.split("\n").filter((line) => line.includes("assess --app"));
  expect(commands.length).toBeGreaterThan(0);
  expect(commands.every((line) => line.includes("assess --app web "))).toBeTrue();
  expect(findings).not.toContain("<application>");
}, 30_000);

test("assessment rejects mutation-only flags before scanning or writing", async () => {
  const root = assessmentFixture();
  const result = await runIn(root, "assess", "--app", "web", "--evidence-dir", "evidence", "--write", "--json");
  expect(result.code).toBe(64);
  expect(result.stderr).toContain("mutation-only --write");
  expect(existsSync(join(root, "evidence"))).toBeFalse();
}, 10_000);

test("batch completeness errors are fatal and publish no partial bundle", async () => {
  const root = assessmentFixture();
  writeFileSync(join(root, "apps/web/src/alpha/model.ts"), 'const invalid: number = "not-a-number"; export interface Alpha { value: number }\n');
  const result = await runIn(root, "split-candidates", "--app", "web", "--evidence-dir", "splits", "--file", "apps/web/src/alpha/model.ts", "--json");
  expect(result.code).toBe(1);
  expect(result.stdout).toMatch(/ASSESSMENT_INPUT_UNBOUND|SPLIT_ANALYSIS_INCOMPLETE/);
  expect(existsSync(join(root, "splits"))).toBeFalse();
}, 15_000);

test("unsupported computed module relationships are structured batch failures", async () => {
  const root = assessmentFixture();
  writeFileSync(join(root, "apps/web/src/alpha/model.ts"), 'const moduleName = "./shared.ts"; export async function load() { return import(moduleName); }\n');
  const result = await runIn(root, "split-candidates", "--app", "web", "--evidence-dir", "splits", "--file", "apps/web/src/alpha/model.ts", "--json");
  expect(result.code).toBe(1);
  const output = JSON.parse(result.stdout) as { code: string; published: boolean; diagnostics: { message: string }[] };
  expect(output).toMatchObject({ code: "SPLIT_ANALYSIS_INCOMPLETE", published: false });
  expect(output.diagnostics.some((entry) => entry.message.includes("unsupported computed module relationship"))).toBeTrue();
  expect(existsSync(join(root, "splits"))).toBeFalse();
}, 15_000);

test("unresolved analyzer relationships are structured batch incompleteness", async () => {
  const root = assessmentFixture();
  writeFileSync(join(root, "apps/web/src/alpha/model.ts"), "export const broken: Missing = 1; export interface Alpha { value: number }\n");
  const result = await runIn(root, "split-candidates", "--app", "web", "--evidence-dir", "splits", "--file", "apps/web/src/alpha/model.ts", "--json");
  expect(result.code).toBe(1);
  const output = JSON.parse(result.stdout) as { code: string; published: boolean; diagnostics: { phase: string; category: string }[] };
  expect(output).toMatchObject({ code: "SPLIT_ANALYSIS_INCOMPLETE", published: false });
  expect(output.diagnostics).toContainEqual(expect.objectContaining({ phase: "semantic", category: "error" }));
  expect(existsSync(join(root, "splits"))).toBeFalse();
}, 15_000);

test("batch selectors reject positional, output, and repeated hotspot conflicts", async () => {
  const root = assessmentFixture();
  const positional = await runIn(root, "split-candidates", "--app", "web", "--evidence-dir", "splits", "--file", "apps/web/src/shared.ts", "extra", "--json");
  expect(positional.code).toBe(64);
  expect(positional.stderr).toContain("rejects positional targets");
  const output = await runIn(
    root,
    "split-candidates",
    "--app",
    "web",
    "--evidence-dir",
    "splits",
    "--file",
    "apps/web/src/shared.ts",
    "--out",
    "legacy.json",
    "--json",
  );
  expect(output.code).toBe(64);
  expect(output.stderr).toContain("rejects positional targets and --out");
  const repeated = await runIn(
    root,
    "split-candidates",
    "--app",
    "web",
    "--evidence-dir",
    "splits",
    "--split-hotspots",
    "1",
    "--split-hotspots",
    "2",
    "--json",
  );
  expect(repeated.code).toBe(64);
  expect(repeated.stderr).toContain("--split-hotspots only once");
  expect(existsSync(join(root, "splits"))).toBeFalse();
}, 20_000);

test("legacy single-file JSON keeps semantic diagnostics outside batch envelopes", async () => {
  const root = assessmentFixture();
  writeFileSync(join(root, "apps/web/src/alpha/model.ts"), "export const broken: Missing = 1; export interface Alpha { value: number }\n");
  const result = await runIn(root, "split-candidates", "--file", "apps/web/src/alpha/model.ts", "--out", "legacy.json", "--json");
  expect(result.code).toBe(0);
  const report = JSON.parse(result.stdout) as {
    schemaVersion: number;
    source: { diagnostics: { code: number; category: string }[] };
    selection?: unknown;
    status?: unknown;
  };
  expect(report.schemaVersion).toBe(1);
  expect(report.source.diagnostics).toContainEqual(expect.objectContaining({ code: 2304, category: "error" }));
  expect(report.selection).toBeUndefined();
  expect(report.status).toBeUndefined();
  expect(JSON.parse(readFileSync(join(root, "legacy.json"), "utf8"))).toEqual(report);
}, 20_000);

function assessmentFixture(): string {
  const root = scratchDirectory();
  for (const dir of ["apps/web/src/alpha", "apps/web/src/beta", "packages/tool/src"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "apps/web/src/shared.ts"), "export const shared = 1;\n");
  writeFileSync(join(root, "apps/web/src/consumer.ts"), 'import { shared } from "./shared.ts"; export const result = shared + 1;\n');
  writeFileSync(
    join(root, "apps/web/src/alpha/model.ts"),
    'import { shared } from "../shared.ts"; export interface Alpha { value: number } export const alpha = shared;\n',
  );
  writeFileSync(
    join(root, "apps/web/src/beta/model.ts"),
    'import { shared } from "../shared.ts"; export interface Beta { value: number } export const beta = shared;\n',
  );
  writeFileSync(join(root, "apps/web/src/cycle-a.ts"), 'import { b } from "./cycle-b.ts"; export function a(): number { return b(); }\n');
  writeFileSync(join(root, "apps/web/src/cycle-b.ts"), 'import { a } from "./cycle-a.ts"; export function b(): number { return a(); }\n');
  writeFileSync(
    join(root, "apps/web/tsconfig.json"),
    '{"compilerOptions":{"module":"esnext","moduleResolution":"bundler","allowImportingTsExtensions":true,"noEmit":true,"strict":true},"include":["src/**/*.ts"]}\n',
  );
  writeFileSync(join(root, "packages/tool/package.json"), '{"name":"@acme/tool"}\n');
  writeFileSync(join(root, "packages/tool/src/index.ts"), "export {};\n");
  writeFileSync(join(root, "package.json"), '{"private":true,"workspaces":["packages/*"]}\n');
  writeFileSync(join(root, "bun.lock"), "{}\n");
  writeFileSync(
    join(root, "monocarve.config.json"),
    `${JSON.stringify({ applications: [{ name: "web", sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json" }], packageRoots: ["packages"], packageManager: "bun", testPathPatterns: ["\\.test\\.ts$"], scaffoldTemplates: { packageJson: { contents: '{"name":"{package}"}\n' } } }, null, 2)}\n`,
  );
  fixtureGit(root, "init", "-q", "-b", "assessment-fixture");
  fixtureGit(root, "config", "user.email", "fixture@example.invalid");
  fixtureGit(root, "config", "user.name", "Fixture");
  fixtureGit(root, "add", ".");
  fixtureGit(root, "commit", "-qm", "fixture");
  return root;
}

function bundleBytes(root: string, current = root): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) Object.assign(result, bundleBytes(root, absolute));
    else result[absolute.slice(root.length + 1)] = readFileSync(absolute, "base64");
  }
  return result;
}
