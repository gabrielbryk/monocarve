import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { hashBytes } from "../src/util/hash.ts";
import { runIn } from "./support/cli.ts";
import { fixtureGit, scratchDirectory } from "./support/fixture-repo.ts";

interface ArtifactRecord {
  path: string;
  bytes: number;
  sha256: string;
  required: boolean;
}
interface AssessmentManifestRecord {
  analyticalArguments: { application: string; limit: number; fullPortfolio: boolean; splitSelection: unknown };
  artifacts: ArtifactRecord[];
  omissions: Array<{ kind: string; reason: string; command: string }>;
  provenance: { capture: string; invocation: string };
  baseline: unknown;
  qualification?: Record<string, unknown>;
}

test("full portfolio is additive while publication controls leave analytical bytes unchanged", async () => {
  const root = assessmentFixture();
  const initial = await runIn(root, "assess", "--app", "web", "--evidence-dir", "evidence", "--limit", "1", "--json");
  expect(initial.code).toBe(0);
  const initialOutput = JSON.parse(initial.stdout) as { totalBytes: number };
  const initialBytes = bundleBytes(join(root, "evidence"));
  const initialManifest = manifest(root, "evidence");
  expect(initialManifest.omissions).toEqual([
    { kind: "full-portfolio", reason: "default output is bounded", command: "assess --app web --evidence-dir <path> --full-portfolio" },
  ]);
  expect(initialManifest.artifacts).toContainEqual(expect.objectContaining({ path: "portfolio.json", required: true }));
  expect(initialManifest.artifacts.some((entry) => entry.path === "portfolio-full.json")).toBeFalse();
  expect(requiredReplayEvidence(initialManifest)).toBeTrue();
  const bounded = JSON.parse(readFileSync(join(root, "evidence/portfolio.json"), "utf8")) as {
    result: { status: string; value?: { limit: number; records: unknown[] } };
  };
  expect(bounded.result).toMatchObject({ status: "available", value: { limit: 1 } });
  expect(bounded.result.value?.records.length).toBeLessThanOrEqual(1);

  const replaced = await runIn(
    root,
    "assess",
    "--app",
    "web",
    "--evidence-dir",
    "evidence",
    "--limit",
    "1",
    "--replace-generated",
    "--max-bytes",
    String(initialOutput.totalBytes + 1_000),
    "--json",
  );
  expect(replaced.code).toBe(0);
  expect(bundleBytes(join(root, "evidence"))).toEqual(initialBytes);

  const full = await runIn(root, "assess", "--app", "web", "--evidence-dir", "full", "--replay", "evidence", "--limit", "1", "--full-portfolio", "--json");
  expect(full.code, `${full.stdout}\n${full.stderr}`).toBe(0);
  const fullOutput = JSON.parse(full.stdout) as { totalBytes: number };
  const fullManifest = manifest(root, "full");
  expect(fullManifest.omissions).toEqual([]);
  expect(fullManifest.artifacts).toContainEqual(expect.objectContaining({ path: "portfolio.json", required: true }));
  const fullRecord = fullManifest.artifacts.find((entry) => entry.path === "portfolio-full.json");
  expect(fullRecord).toMatchObject({ required: false });
  expect(readFileSync(join(root, "full/findings.md"), "utf8")).not.toContain("Full portfolio details omitted by default");
  const fullPortfolio = JSON.parse(readFileSync(join(root, "full/portfolio-full.json"), "utf8")) as { result: { status: string; value?: unknown[] } };
  expect(fullPortfolio.result.status).toBe("available");
  expect(fullPortfolio.result.value?.length ?? 0).toBeGreaterThanOrEqual(bounded.result.value?.records.length ?? 0);

  const optionalBudget = fullOutput.totalBytes - fullRecord!.bytes;
  const optionalFailure = await runIn(
    root,
    "assess",
    "--app",
    "web",
    "--evidence-dir",
    "full",
    "--replay",
    "evidence",
    "--limit",
    "1",
    "--full-portfolio",
    "--replace-generated",
    "--max-bytes",
    String(optionalBudget),
    "--json",
  );
  expect(optionalFailure.code).toBe(1);
  expect(optionalFailure.stdout).toContain("omit only requested optional evidence (portfolio-full.json)");
  expect(readFileSync(join(root, "full/portfolio-full.json"), "utf8")).toBe(JSON.stringify(fullPortfolio, null, 2) + "\n");

  const requiredFailure = await runIn(
    root,
    "assess",
    "--app",
    "web",
    "--evidence-dir",
    "full",
    "--replay",
    "evidence",
    "--limit",
    "1",
    "--replace-generated",
    "--max-bytes",
    String(initialOutput.totalBytes - 1),
    "--json",
  );
  expect(requiredFailure.code).toBe(1);
  expect(requiredFailure.stdout).toContain("required evidence alone exceeds the budget; no optional omission can satisfy it");
  expect(bundleBytes(join(root, "evidence"))).toEqual(initialBytes);

  rmSync(join(root, "evidence"), { recursive: true });
  rmSync(join(root, "full"), { recursive: true });
  const renamed = await runIn(
    root,
    "assess",
    "--app",
    "web",
    "--evidence-dir",
    "renamed",
    "--limit",
    "1",
    "--max-bytes",
    String(initialOutput.totalBytes + 1_000),
    "--json",
  );
  expect(renamed.code).toBe(0);
  expect(bundleBytes(join(root, "renamed"))).toEqual(initialBytes);
}, 60_000);

test("assessment replay rejects forged required flags, omissions, and optional inventory entries", async () => {
  const root = assessmentFixture();
  const captured = await runIn(root, "assess", "--app", "web", "--evidence-dir", "evidence", "--json");
  expect(captured.code).toBe(0);
  const manifestPath = join(root, "evidence/manifest.json");
  const original = readFileSync(manifestPath, "utf8");

  const requiredForgery = JSON.parse(original) as AssessmentManifestRecord;
  requiredForgery.artifacts.find((entry) => entry.path === "input-inventory.json")!.required = false;
  writeManifest(manifestPath, requiredForgery);
  await expectReplayRefusal(root, "input-inventory.json must be present and required");

  const omissionForgery = JSON.parse(original) as AssessmentManifestRecord;
  omissionForgery.omissions = [];
  writeManifest(manifestPath, omissionForgery);
  await expectReplayRefusal(root, "full portfolio omission recipe is missing or non-canonical");

  const qualificationForgery = JSON.parse(original) as AssessmentManifestRecord;
  qualificationForgery.qualification = { ...qualificationForgery.qualification, status: "fatal", exitCode: 1, mayPublish: false };
  writeManifest(manifestPath, qualificationForgery);
  await expectReplayRefusal(root, "qualification status, diagnostics, or overrides are inconsistent");

  const argumentForgery = JSON.parse(original) as AssessmentManifestRecord;
  argumentForgery.analyticalArguments.limit += 1;
  writeManifest(manifestPath, argumentForgery);
  await expectReplayRefusal(root, "limit or record inventory disagrees with analytical arguments");

  const optionalForgery = JSON.parse(original) as AssessmentManifestRecord;
  const invented = new TextEncoder().encode("invented optional evidence\n");
  writeFileSync(join(root, "evidence/invented.json"), invented);
  optionalForgery.artifacts.push({ path: "invented.json", bytes: invented.byteLength, sha256: hashBytes(invented), required: false });
  optionalForgery.artifacts.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  writeManifest(manifestPath, optionalForgery);
  await expectReplayRefusal(root, "artifact inventory contains an unknown assessment artifact");
}, 60_000);

test("standalone batch manifest binds replay provenance, mandatory evidence, source hashes, and no portfolio omissions", async () => {
  const root = assessmentFixture();
  const captured = await runIn(root, "assess", "--app", "web", "--evidence-dir", "evidence", "--json");
  expect(captured.code).toBe(0);
  const batch = await runIn(
    root,
    "split-candidates",
    "--app",
    "web",
    "--evidence-dir",
    "splits",
    "--replay",
    "evidence",
    "--file",
    "apps/web/src/alpha/model.ts",
    "--file",
    "apps/web/src/beta/model.ts",
    "--json",
  );
  expect(batch.code).toBe(0);
  const aggregate = JSON.parse(readFileSync(join(root, "splits/batch-aggregate.json"), "utf8")) as {
    entries: Array<{ sourcePath: string; reportPath: string; sourceHash: string }>;
  };
  const batchManifest = JSON.parse(readFileSync(join(root, "splits/manifest.json"), "utf8")) as AssessmentManifestRecord & {
    sourceHashes: Record<string, string>;
  };
  expect(batchManifest.provenance).toEqual({ capture: "live", invocation: "replay" });
  expect(batchManifest.omissions).toEqual([]);
  expect(batchManifest.baseline).toEqual(manifest(root, "evidence").baseline);
  expect(batchManifest.artifacts.every((entry) => entry.required)).toBeTrue();
  expect(batchManifest.artifacts).toContainEqual(expect.objectContaining({ path: "input-inventory.json", required: true }));
  expect(batchManifest.artifacts).toContainEqual(expect.objectContaining({ path: "batch-aggregate.json", required: true }));
  expect(batchManifest.artifacts.some((entry) => entry.path.startsWith("raw/") && entry.required)).toBeTrue();
  expect(batchManifest.artifacts.some((entry) => entry.path === "portfolio-full.json")).toBeFalse();
  expect(batchManifest.sourceHashes).toEqual(Object.fromEntries(aggregate.entries.map((entry) => [entry.sourcePath, entry.sourceHash])));
  expect(new Set(aggregate.entries.map((entry) => entry.reportPath))).toEqual(
    new Set(batchManifest.artifacts.filter((entry) => entry.path.startsWith("splits/")).map((entry) => entry.path)),
  );
}, 60_000);

async function expectReplayRefusal(root: string, detail: string): Promise<void> {
  rmSync(join(root, "replayed"), { recursive: true, force: true });
  const replay = await runIn(root, "assess", "--app", "web", "--evidence-dir", "replayed", "--replay", "evidence", "--json");
  expect(replay.code).toBe(1);
  expect(replay.stdout).toContain("ASSESSMENT_REPLAY_PROVENANCE_REQUIRED");
  expect(replay.stdout).toContain(detail);
  expect(existsSync(join(root, "replayed"))).toBeFalse();
}

function requiredReplayEvidence(value: AssessmentManifestRecord): boolean {
  return (
    value.artifacts.some((entry) => entry.path === "input-inventory.json" && entry.required) &&
    value.artifacts.some((entry) => entry.path.startsWith("raw/") && entry.required)
  );
}

function manifest(root: string, directory: string): AssessmentManifestRecord {
  return JSON.parse(readFileSync(join(root, directory, "manifest.json"), "utf8")) as AssessmentManifestRecord;
}

function writeManifest(path: string, value: AssessmentManifestRecord): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

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
  fixtureGit(root, "init", "-q", "-b", "assessment-manifest-fixture");
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
