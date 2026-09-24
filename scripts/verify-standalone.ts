/** Post-build proof that the standalone assessment has no adjacent package manifest dependency. */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { fixtureGit } from "../test/support/fixture-repo.ts";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "monocarve-standalone-"));
try {
  const binary = join(scratch, "assessment-tool");
  const workspace = join(scratch, "workspace");
  copyFileSync(join(root, "artifacts/monocarve"), binary);
  mkdirSync(join(workspace, "apps/web/src"), { recursive: true });
  mkdirSync(join(workspace, "packages"), { recursive: true });
  writeFileSync(join(workspace, "apps/web/src/main.ts"), 'import { value } from "./value.ts"; export const main = value;\n');
  writeFileSync(join(workspace, "apps/web/src/value.ts"), "export const value = 1;\n");
  writeFileSync(
    join(workspace, "apps/web/tsconfig.json"),
    '{"compilerOptions":{"module":"esnext","moduleResolution":"bundler","allowImportingTsExtensions":true,"noEmit":true},"include":["src/**/*.ts"]}\n',
  );
  writeFileSync(join(workspace, "package.json"), '{"private":true,"workspaces":[]}\n');
  writeFileSync(join(workspace, "bun.lock"), "{}\n");
  writeFileSync(
    join(workspace, "monocarve.config.json"),
    `${JSON.stringify({
      applications: [{ name: "web", sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json" }],
      packageRoots: ["packages"],
      packageManager: "bun",
      scaffoldTemplates: { packageJson: { contents: '{"name":"{package}"}\n' } },
    })}\n`,
  );
  fixtureGit(workspace, "init", "-q");
  fixtureGit(workspace, "config", "user.email", "fixture@example.invalid");
  fixtureGit(workspace, "config", "user.name", "Fixture");
  fixtureGit(workspace, "add", ".");
  fixtureGit(workspace, "commit", "-qm", "fixture");
  const result = Bun.spawnSync([binary, "--cwd", workspace, "assess", "--app", "web", "--evidence-dir", "evidence", "--json"], {
    cwd: scratch,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0 || !existsSync(join(workspace, "evidence/manifest.json"))) {
    throw new Error(
      `relocated standalone assessment failed (${result.exitCode}): ${new TextDecoder().decode(result.stderr)} ${new TextDecoder().decode(result.stdout)}`,
    );
  }
  const manifest = JSON.parse(readFileSync(join(workspace, "evidence/manifest.json"), "utf8")) as {
    baseline: { runtime: { dependencies: Record<string, string> } };
  };
  for (const name of ["dependency-cruiser", "typescript"]) {
    const expected = (JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")) as { version: string }).version;
    if (manifest.baseline.runtime.dependencies[name] !== expected) throw new Error(`standalone did not stamp installed ${name} version`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
