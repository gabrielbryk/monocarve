/**
 * The scheduler is tested against an injected runner rather than wall-clock
 * shell commands. These proofs fail if it exceeds the configured limit, emits
 * completion order, selects the first process to fail, or crosses a tier
 * barrier before the prior tier is complete.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseConfig } from "../src/config.ts";
import { runGateTiers, type GateCommandRunner } from "../src/transaction/simulate.ts";
import { scratchDirectory } from "./support/fixture-repo.ts";

const emptyGates = { package: [], project: [], workspace: [] } as const;

function gateConfig(gates: unknown = {}): unknown {
  return {
    applications: [{ name: "app", sourceRoot: "apps/app/src", tsconfig: "apps/app/tsconfig.json" }],
    packageRoots: ["packages"],
    scaffoldTemplates: { packageJson: { contents: "{}" } },
    gates,
  };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("gate concurrency", () => {
  test("default gate processes use cleaned scratch beside the gated workspace", async () => {
    const parent = scratchDirectory();
    const cwd = join(parent, "workspace");
    await Bun.write(join(cwd, ".keep"), "");
    const observed = join(cwd, "observed-tmpdir.txt");
    const result = await runGateTiers({
      gates: { ...emptyGates, workspace: ["record temp"] },
      maxConcurrency: 1,
      cwd,
      timeoutMs: 1_000,
      wrapCommand: () => [process.execPath, "-e", `await Bun.write(${JSON.stringify(observed)}, process.env.TMPDIR ?? '')`],
    });

    expect(result.failure).toBeUndefined();
    const temp = readFileSync(observed, "utf8");
    expect(temp.startsWith(parent)).toBeTrue();
    expect(temp).toContain(".monocarve-gate-tmp-");
    expect(existsSync(temp)).toBeFalse();
  });

  test("defaults to serial execution and rejects invalid limits", () => {
    expect(parseConfig(gateConfig()).gates.maxConcurrency).toBe(1);
    expect(parseConfig(gateConfig()).transaction.gateRetries).toBe(0);
    expect(() => parseConfig(gateConfig({ maxConcurrency: 0 }))).toThrow(/maxConcurrency/);
    expect(() => parseConfig(gateConfig({ maxConcurrency: 1.5 }))).toThrow(/maxConcurrency/);
  });

  test("an explicit retry policy records every failed attempt before success", async () => {
    let calls = 0;
    const result = await runGateTiers({
      gates: { ...emptyGates, workspace: ["flaky"] }, maxConcurrency: 1, retries: 2,
      cwd: "/fixture", timeoutMs: 1_000, wrapCommand: (command) => [command],
      runner: async () => {
        calls += 1;
        return { exitCode: calls < 3 ? 9 : 0, stdout: `attempt ${calls}`, stderr: "" };
      },
    });

    expect(calls).toBe(3);
    expect(result.failure).toBeUndefined();
    expect(result.results[0]?.attempts?.map((attempt) => attempt.exitCode)).toEqual([9, 9, 0]);
    expect(result.results[0]?.attempts?.[0]?.output).toContain("attempt 1");
  });

  test("limits a tier while preserving declared result order and declared failure selection", async () => {
    let active = 0;
    let peak = 0;
    const completions: string[] = [];
    const runner: GateCommandRunner = async ([command]) => {
      active += 1;
      peak = Math.max(peak, active);
      // Later commands deliberately finish first. Selecting/process-pushing by
      // completion order would report `third` as the failure before `second`.
      await Bun.sleep({ first: 30, second: 20, third: 10 }[command!]!);
      active -= 1;
      completions.push(command!);
      return { exitCode: command === "second" || command === "third" ? 1 : 0, stdout: `${command}\n`, stderr: "" };
    };

    const result = await runGateTiers({
      gates: { ...emptyGates, package: ["first", "second", "third"] },
      maxConcurrency: 3,
      cwd: "/fixture",
      timeoutMs: 1_000,
      wrapCommand: (command) => [command],
      runner,
    });

    expect(peak).toBe(3);
    expect(completions).toEqual(["third", "second", "first"]);
    expect(result.results.map((gate) => gate.command)).toEqual(["first", "second", "third"]);
    expect(result.failure?.command).toBe("second");
  });

  test("a limit of two admits only two blocked commands before a slot frees", async () => {
    const release = new Map([
      ["first", deferred()],
      ["second", deferred()],
      ["third", deferred()],
    ]);
    const started: string[] = [];
    const runner: GateCommandRunner = async ([command]) => {
      started.push(command!);
      await release.get(command!)!.promise;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const running = runGateTiers({
      gates: { ...emptyGates, package: ["first", "second", "third"] },
      maxConcurrency: 2,
      cwd: "/fixture",
      timeoutMs: 1_000,
      wrapCommand: (command) => [command],
      runner,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["first", "second"]);
    release.get("first")!.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["first", "second", "third"]);
    release.get("second")!.resolve();
    release.get("third")!.resolve();
    await running;
  });

  test("a concurrent failure stops later admission but awaits the admitted peer", async () => {
    const releaseSecond = deferred();
    const started: string[] = [];
    const runner: GateCommandRunner = async ([command]) => {
      started.push(command!);
      if (command === "first") return { exitCode: 1, stdout: "failed", stderr: "" };
      if (command === "second") await releaseSecond.promise;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const running = runGateTiers({
      gates: { ...emptyGates, package: ["first", "second", "third"] },
      maxConcurrency: 2,
      cwd: "/fixture",
      timeoutMs: 1_000,
      wrapCommand: (command) => [command],
      runner,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["first", "second"]);
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBeFalse();
    releaseSecond.resolve();
    const result = await running;
    expect(started).toEqual(["first", "second"]);
    expect(result.results.map((gate) => gate.command)).toEqual(["first", "second"]);
    expect(result.failure?.command).toBe("first");
  });

  test("does not begin a later tier until every command in the prior tier has completed", async () => {
    const releasePackage = deferred();
    const started: string[] = [];
    const runner: GateCommandRunner = async ([command]) => {
      started.push(command!);
      if (command === "package-a") await releasePackage.promise;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const running = runGateTiers({
      gates: { package: ["package-a", "package-b"], project: ["project-a"], workspace: [] },
      maxConcurrency: 2,
      cwd: "/fixture",
      timeoutMs: 1_000,
      wrapCommand: (command) => [command],
      runner,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["package-a", "package-b"]);
    releasePackage.resolve();
    await running;
    expect(started).toEqual(["package-a", "package-b", "project-a"]);
  });

  test("runs a default-config tier serially", async () => {
    const config = parseConfig(gateConfig());
    const releaseFirst = deferred();
    const started: string[] = [];
    const runner: GateCommandRunner = async ([command]) => {
      started.push(command!);
      if (command === "first") await releaseFirst.promise;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const running = runGateTiers({
      gates: { ...emptyGates, workspace: ["first", "second"] },
      maxConcurrency: config.gates.maxConcurrency,
      cwd: "/fixture",
      timeoutMs: config.gates.timeoutMs,
      wrapCommand: (command) => [command],
      runner,
    });

    await Promise.resolve();
    expect(started).toEqual(["first"]);
    releaseFirst.resolve();
    await running;
    expect(started).toEqual(["first", "second"]);
  });

  test("the default serial limit does not begin a later gate after a failure", async () => {
    const config = parseConfig(gateConfig());
    const started: string[] = [];
    const result = await runGateTiers({
      gates: { ...emptyGates, workspace: ["first", "second"] },
      maxConcurrency: config.gates.maxConcurrency,
      cwd: "/fixture",
      timeoutMs: config.gates.timeoutMs,
      wrapCommand: (command) => [command],
      runner: async ([command]) => {
        started.push(command!);
        return { exitCode: 1, stdout: "failed", stderr: "" };
      },
    });

    expect(started).toEqual(["first"]);
    expect(result.results.map((gate) => gate.command)).toEqual(["first"]);
    expect(result.failure?.command).toBe("first");
  });

  test("a long failure keeps opening context and the actionable tail of both streams", async () => {
    const diagnosticsDirectory = join(scratchDirectory(), "gate-diagnostics");
    const middle = "middle-only-diagnostic";
    const result = await runGateTiers({
      gates: { ...emptyGates, workspace: ["lint"] },
      maxConcurrency: 1,
      cwd: "/fixture",
      timeoutMs: 1_000,
      wrapCommand: (command) => [command],
      diagnosticsDirectory,
      runner: async () => ({
        exitCode: 1,
        stdout: `linting target package\n${"output-noise\n".repeat(600)}${middle}\n${"more-noise\n".repeat(600)}packages/example/src/Broken.ts:7:3 error no-unsafe-call\n`,
        stderr: `runner context\n${"stderr-noise\n".repeat(600)}ELIFECYCLE Command failed with exit code 1\n`,
      }),
    });

    const output = result.failure?.output ?? "";
    expect(output).toContain("linting target package");
    expect(output).toContain("packages/example/src/Broken.ts:7:3 error no-unsafe-call");
    expect(output).toContain("runner context");
    expect(output).toContain("ELIFECYCLE Command failed with exit code 1");
    expect(output.length).toBeLessThanOrEqual(8_000);
    expect(result.failure?.outputHead).toContain("--- stdout ---");
    expect(result.failure?.outputTail).toContain("ELIFECYCLE Command failed with exit code 1");
    expect(result.failure?.outputHead).not.toContain(middle);
    expect(result.failure?.outputTail).not.toContain(middle);
    const logPath = result.failure?.logPath ?? "";
    expect(existsSync(logPath)).toBeTrue();
    expect(readFileSync(logPath, "utf8")).toContain(middle);
    expect(logPath.startsWith(diagnosticsDirectory)).toBeTrue();
  });

  test("a diagnostic write failure preserves the authoritative gate result", async () => {
    const result = await runGateTiers({
      gates: { ...emptyGates, workspace: ["lint"] },
      maxConcurrency: 1,
      cwd: "/fixture",
      timeoutMs: 1_000,
      wrapCommand: (command) => [command],
      diagnosticsDirectory: "/outside-gated-tree",
      writeDiagnostic: () => {
        throw new Error("scratch is read-only");
      },
      runner: async () => ({ exitCode: 17, stdout: "context", stderr: "actionable failure" }),
    });

    expect(result.failure).toMatchObject({
      command: "lint",
      tier: "workspace",
      exitCode: 17,
      logWriteFailure: "scratch is read-only",
    });
    expect(result.failure?.logPath).toBeUndefined();
    expect(result.failure?.outputTail).toContain("actionable failure");
  });
});
