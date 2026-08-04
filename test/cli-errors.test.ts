/**
 * What the CLI does with a mistake.
 *
 * The failures here are all *ordinary*: a mistyped path, a file that is not the
 * file it was said to be, a directory that cannot be written. Every one of them
 * used to leave the process by throwing out of `main`, so the operator got a
 * stack trace naming a line of `src/cli.ts` — a report about this tool's
 * internals in answer to a question about their own arguments.
 *
 * Each test therefore asserts three separable things, because any two of them
 * can hold while the third is broken:
 *
 *   1. the exit code says what *kind* of failure it was (`1` expected, `64`
 *      malformed invocation, `70` internal — nothing crashes out at random);
 *   2. the message names the input, as the operator typed it, and what was
 *      wrong with it;
 *   3. no stack frames on stderr, since there is nothing here to debug.
 *
 * And every negative is paired with a control that succeeds. "Report every
 * input as broken" satisfies (1)–(3) trivially and is a worse tool than the one
 * that crashed, so the controls are what make these proofs rather than
 * decoration.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanupFixtures, fixtureGit, scratchDirectory } from "./support/fixture-repo.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const FIXTURE = join(ROOT, "fixtures/basic-monorepo");
const CLI = join(ROOT, "src/cli.ts");

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runIn(cwd: string, ...args: string[]): Promise<RunResult> {
  const child = Bun.spawn(["bun", CLI, "--cwd", cwd, ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

/**
 * A copy of the fixture the test owns outright, committed on an unguarded branch.
 *
 * These tests write plans, break files, and revoke read permission. The shared
 * `fixtures/basic-monorepo` is input data for every other suite — and, while
 * this repository is being worked on, for other people's suites running
 * concurrently — so nothing here touches it in place.
 *
 * It is a real repository because the tool is: a plan records the commit its
 * blobs came from, and outside a repository git writes `fatal: not a git
 * repository` onto the stderr these tests read. Committing makes every stderr
 * assertion below about this tool's own output.
 */
function workspace(): string {
  const root = join(scratchDirectory(), "workspace");
  cpSync(FIXTURE, root, { recursive: true });
  rmSync(join(root, ".monocarve"), { recursive: true, force: true });
  // Written before the commit so the tree stays clean once these tests start
  // writing plans into it — a dirty tree is a refusal `plan` earns honestly,
  // and it would stand in for the failures under test.
  writeFileSync(join(root, ".gitignore"), ".monocarve/\nplans/\nreports/\n");
  fixtureGit(root, "init", "-q", "-b", "cli-errors-fixture");
  fixtureGit(root, "config", "user.email", "fixture@example.invalid");
  fixtureGit(root, "config", "user.name", "Monocarve Fixture");
  fixtureGit(root, "config", "commit.gpgsign", "false");
  fixtureGit(root, "add", "-A");
  fixtureGit(root, "commit", "-qm", "test: seed cli-errors workspace");
  return root;
}

function write(root: string, path: string, contents: string): string {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
  return path;
}

/**
 * The assertion that fails on every pre-fix crash, stated once.
 *
 * A stack frame on stderr is the tell: Bun prints ` at fn (…/src/cli.ts:250:42)`
 * for an uncaught throw, and that line is what makes an operator believe they
 * have found a bug. `not.toContain("Error:")` would *not* do — `PlanningError:`
 * is exactly what a good report starts with. It is the frames that must be
 * absent, and the internal-error verdict with them.
 */
function expectCleanFailure(result: RunResult, mentions: readonly string[]): void {
  expect(result.code).toBe(1);
  // Not the codes reserved for the other two kinds of failure: `64` would claim
  // the invocation was malformed, `70` that this tool is broken.
  expect(result.code).not.toBe(64);
  expect(result.code).not.toBe(70);
  expect(result.stderr).not.toMatch(/^\s+at /m);
  expect(result.stderr).not.toContain("src/cli.ts:");
  expect(result.stderr).not.toContain("internal error");
  // A precondition failure is not a usage error, so no usage block either.
  expect(result.stderr).not.toContain("usage:");
  for (const fragment of mentions) expect(result.stderr).toContain(fragment);
  // One sentence, not a report: anything multi-line here is a trace that slipped
  // past the checks above in a shape they did not anticipate.
  expect(result.stderr.trim().split("\n")).toHaveLength(1);
}

const VALID_REPORT = `${JSON.stringify(
  {
    modules: [
      {
        source: "apps/web/src/main.ts",
        dependencies: [{ module: "./widgets/chart.ts", resolved: "apps/web/src/widgets/chart.ts" }],
      },
      { source: "apps/web/src/widgets/chart.ts", dependencies: [] },
    ],
  },
  null,
  2,
)}\n`;

describe("cli error reporting", () => {
  afterAll(() => {
    cleanupFixtures();
  });

  /**
   * The defect this file was opened for.
   *
   * Pre-fix, `audit --plan <nonexistent>` threw `ENOENT` straight out of
   * `loadManifest`, and stderr read:
   *
   *   ENOENT: no such file or directory, open '…/.monocarve/nope.json'
   *       at loadManifest (…/src/cli.ts:250:42)
   *       at <anonymous> (…/src/cli.ts:467:34)
   *       at async main (…/src/cli.ts:569:16)
   *
   * — a stack trace for a typo. Both `toHaveLength(1)` and the `^\s+at ` check
   * in `expectCleanFailure` fail on that output.
   */
  test("a plan manifest that is not there names the path, and does not crash", async () => {
    const root = workspace();
    const missing = await runIn(root, "audit", "--plan", ".monocarve/nope.json");
    expectCleanFailure(missing, [".monocarve/nope.json", "could not read", "no such file or directory"]);

    // A directory is the same mistake wearing a different errno, and it took the
    // same path out of the process (`EISDIR`).
    mkdirSync(join(root, "plans"), { recursive: true });
    const directory = await runIn(root, "audit", "--plan", "plans");
    expectCleanFailure(directory, ["plans", "could not read"]);

    // The control. Without it, "report every plan path as unreadable" passes
    // everything above: a manifest that *is* there is read, audited, and
    // reported on stdout with nothing on stderr at all. It fails — nothing has
    // been applied — but it fails with evidence, which is a different outcome
    // from failing to be opened.
    const audited = await runIn(root, "audit", "--plan", await planFor(root));
    expect(audited.stderr).toBe("");
    const report = JSON.parse(audited.stdout) as { passed: boolean; byteFidelity: { checked: number } };
    expect(report.passed).toBe(false);
    expect(report.byteFidelity.checked).toBeGreaterThan(0);
  }, 120_000);

  /**
   * Bytes that are not a manifest.
   *
   * The unparseable case was already clean before this change — `parseManifest`
   * has always converted `JSON.parse`'s `SyntaxError` into a `PlanningError` —
   * and it is asserted here anyway, because the missing-file fix must not be
   * made by a catch that swallows it into something less specific.
   *
   * The second case is the one that crashed. `null` parses, so `parseManifest`
   * returned it, cast to `ExtractionManifest`, and the audit died three modules
   * away on `TypeError: null is not an object (evaluating 'value.schemaVersion')`
   * at `src/transaction/audit.ts:242` — a crash site with no connection to the
   * file the operator named.
   */
  test("a manifest that is not JSON, and one that is not a JSON object, both report the file", async () => {
    const root = workspace();

    const garbage = write(root, "plans/garbage.json", "this is not json at all\n");
    expectCleanFailure(await runIn(root, "audit", "--plan", garbage), [garbage, "could not parse"]);

    for (const [name, contents, described] of [
      ["null", "null\n", "null"],
      ["array", "[]\n", "an array"],
      ["string", '"a manifest"\n', "string"],
    ] as const) {
      const path = write(root, `plans/${name}.json`, contents);
      expectCleanFailure(await runIn(root, "audit", "--plan", path), [path, "is not a JSON object", described]);
    }

    // The control, and it matters more here than anywhere: a JSON *object* is
    // not waved through by the same guard. It reaches the audit, which reports
    // on it — this fix rejects the four things that cannot be a manifest, not
    // everything it has not seen before.
    const stranger = write(root, "plans/stranger.json", '{"hello": 1}\n');
    const audited = await runIn(root, "audit", "--plan", stranger);
    expect(audited.stderr).toBe("");
    expect(audited.code).toBe(1);
    expect((JSON.parse(audited.stdout) as { failures: string[] }).failures).toEqual([
      "[schema-version] manifest schemaVersion must be 2",
    ]);
  }, 120_000);

  /**
   * `--graph` replays a captured scanner report, so the file is as
   * operator-supplied as the plan is — and it had all three failures at once:
   * `readFileSync` threw `ENOENT`, `JSON.parse` threw `SyntaxError`, and a file
   * that parsed but was not a report was cast to one and killed the graph
   * builder with `TypeError: undefined is not an object (evaluating
   * 'report.modules')` at `src/graph/build.ts:99`.
   */
  test("a scanner report that cannot be read, parsed, or believed names the file", async () => {
    const root = workspace();
    const graph = (path: string): Promise<RunResult> => runIn(root, "scan", "--app", "web", "--graph", `web=${path}`);

    expectCleanFailure(await graph("reports/nope.json"), ["reports/nope.json", "could not read"]);

    const garbage = write(root, "reports/garbage.json", "not json\n");
    expectCleanFailure(await graph(garbage), [garbage, "could not parse"]);

    // Parses, and is not a report. Each of these dies on a different field, and
    // each names that field rather than the line that dereferenced it.
    const shapes: readonly (readonly [string, string, string])[] = [
      ["object", '{"hello": 1}\n', 'no "modules" array'],
      ["modules", '{"modules": "all of them"}\n', 'no "modules" array'],
      ["entries", '{"modules": [3]}\n', "modules[0] is not an object"],
      ["source", '{"modules": [{}]}\n', 'modules[0] has no "source" string'],
      ["deps", '{"modules": [{"source": "apps/web/src/main.ts"}]}\n', 'modules[0] has no "dependencies" array'],
      [
        "module",
        '{"modules": [{"source": "apps/web/src/main.ts", "dependencies": [{"resolved": "x"}]}]}\n',
        'modules[0].dependencies[0] has no "module" string',
      ],
    ];
    for (const [name, contents, detail] of shapes) {
      const path = write(root, `reports/${name}.json`, contents);
      expectCleanFailure(await graph(path), [path, detail]);
    }

    // The control: a report of the right shape is accepted and replayed, so the
    // validation above is a shape check and not a refusal to use `--graph`. The
    // module count is the proof it was really used — the fixture's own cruise
    // finds far more than two.
    const valid = write(root, "reports/valid.json", VALID_REPORT);
    const replayed = await graph(valid);
    expect(replayed.stderr).toBe("");
    expect(replayed.code).toBe(0);
    expect((JSON.parse(replayed.stdout) as { moduleCount: number }).moduleCount).toBe(2);
  }, 120_000);

  /**
   * `--out` is the one file the CLI writes rather than reads. Pre-fix a path
   * whose parent could not be created threw `ENOENT` out of `writeOutput` with
   * the same stack-trace-for-a-typo result; the answer had been computed and
   * was lost on the way to disk.
   */
  test("an --out that cannot be written is reported, and one that can is written", async () => {
    const root = workspace();
    // Replayed rather than cruised, so the only thing that can fail in these two
    // runs is the write.
    const report = write(root, "reports/valid.json", VALID_REPORT);
    const scan = (out: string): Promise<RunResult> =>
      runIn(root, "scan", "--app", "web", "--graph", `web=${report}`, "--out", out);

    // A directory cannot be replaced by the atomic output-file rename. This
    // exercises the write failure without asking the CLI to escape its root.
    expectCleanFailure(await scan("reports"), ["reports", "could not write"]);

    const ok = await scan("reports/scan-summary.json");
    expect(ok.stderr).toBe("");
    expect(ok.code).toBe(0);
    expect(existsSync(join(root, "reports/scan-summary.json"))).toBe(true);
  }, 120_000);

  /**
   * The end-to-end control for the whole file: a current-schema plan, verified.
   *
   * Every test above pairs its negatives with a local control, and this is the
   * global one — a plan compiled and read back by a second process, on a clean
   * checkout, exiting `0`. A fix that satisfied the negatives by treating every
   * manifest as unreadable fails here, and nowhere else.
   */
  test("a valid, current-schema invocation still succeeds", async () => {
    const root = workspace();
    const portfolio = JSON.parse(
      (await runIn(root, "portfolio", "--json")).stdout,
    ) as { top: { id: string }[] };
    expect(portfolio.top.length).toBeGreaterThan(0);

    const planned = await runIn(root, "plan", "--candidate", portfolio.top[0]!.id, "--write", "--out", "plans/ok.json");
    expect(planned.stderr).toBe("");
    expect(planned.code).toBe(0);
    expect(existsSync(join(root, "plans/ok.json"))).toBe(true);

    const verified = await runIn(root, "verify", "--plan", "plans/ok.json");
    expect(verified.stderr).toBe("");
    expect(verified.code).toBe(0);
    const report = JSON.parse(verified.stdout) as { validation: { ok: boolean }; blockers: string[] };
    expect(report.validation.ok).toBe(true);
    expect(report.blockers).toEqual([]);
  }, 180_000);

  /**
   * The backstop, and the reason it is not just a nicer crash.
   *
   * Triggered without a seam: `check import-extensions` reads every source file
   * it walks (`src/checks/import-extensions.ts:84`, an unguarded `readFileSync`),
   * so revoking read permission on one makes it throw `EACCES` from inside a
   * stage — a failure no boundary claims and no operator caused by typing
   * anything. Pre-fix that left the process as a bare trace; it now exits `70`
   * with a verdict on top of the same trace.
   *
   * What is asserted is the *distinction*, not the wording: this failure and the
   * ordinary ones above cannot be confused by a script (`70` vs `1`) or by a
   * reader (a stack, and a sentence saying the tool is at fault, vs neither).
   * And the detail survives — a backstop that printed "something went wrong"
   * would pass an exit-code assertion and be worse than the crash it replaced,
   * so the frames naming the throwing module are required to be there.
   */
  test("an unexpected internal failure is reported distinguishably, with its detail intact", async () => {
    if (process.getuid?.() === 0) {
      // Root reads a mode-000 file regardless, so the trigger would not fire and
      // the test would assert nothing. Named rather than silently green.
      throw new Error("this test cannot run as root: mode 000 does not deny root a read");
    }
    const root = workspace();
    const unreadable = join(root, "libs/format/src/number.ts");

    // The control first, on the same tree, before anything is broken: this
    // command succeeds, so what the next run reports is the revoked permission
    // and not the fixture, the config, or the check itself.
    const clean = await runIn(root, "check", "import-extensions");
    expect(clean.code).toBe(0);
    expect(clean.stderr).toBe("");

    chmodSync(unreadable, 0o000);
    try {
      const crashed = await runIn(root, "check", "import-extensions");

      // 1. A code of its own. Not `0`, not the `1` of an expected failure, not
      //    the `64` of a bad invocation.
      expect(crashed.code).toBe(70);

      // 2. A verdict a reader cannot mistake for their own mistake.
      expect(crashed.stderr).toContain("internal error");
      expect(crashed.stderr).toContain("not a mistake in the command");
      // It says which command, since a crash report that omits it is one more
      // thing to reconstruct.
      expect(crashed.stderr).toContain("check");

      // 3. The detail, intact. The original message and the frames that name the
      //    module that threw — this is the half a "clean" backstop would eat.
      expect(crashed.stderr).toContain("EACCES");
      expect(crashed.stderr).toContain("number.ts");
      expect(crashed.stderr).toMatch(/^\s+at /m);
      expect(crashed.stderr).toContain("src/checks/import-extensions.ts");

      // 4. And it is not dressed as an expected failure: no error class from the
      //    taxonomy is claimed for something outside it.
      expect(crashed.stderr).not.toMatch(/^(Usage|Planning|Config|Scan|Io|Preflight)Error:/m);
    } finally {
      chmodSync(unreadable, 0o644);
    }
  }, 120_000);
});

/** A manifest compiled and written by the CLI itself, at a path inside `root`. */
async function planFor(root: string, out = "plans/manifest.json"): Promise<string> {
  const portfolio = JSON.parse((await runIn(root, "portfolio", "--json")).stdout) as { top: { id: string }[] };
  const first = portfolio.top[0];
  if (!first) throw new Error("fixture portfolio produced no eligible candidate");
  const planned = await runIn(root, "plan", "--candidate", first.id, "--write", "--out", out);
  if (planned.code !== 0) throw new Error(`plan exited ${planned.code}:\n${planned.stderr}`);
  return out;
}
