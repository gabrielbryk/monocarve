/** Move commit scope proofs. */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { assertExactMoveDiff, assertExactScope } from "../src/transaction/apply.ts";
import { hashText } from "../src/util/hash.ts";
import type { MoveOperation } from "../src/plan/manifest.ts";
import { cleanupFixtures, fixtureGit, fixtureRepo, write } from "./support/fixture-repo.ts";

describe("commit scope assertions", () => {
  afterEach(cleanupFixtures);

  const VALUE = "export const value = 1;\n";

  function move(source: string, target: string, contents: string): MoveOperation {
    const hash = hashText(contents);
    return { kind: "move", source, target, preconditionHash: hash, resultHash: hash };
  }

  function stagedDiff(root: string): string {
    return fixtureGit(root, "diff", "--cached", "--name-status", "--find-renames=100%", "--");
  }

  test("accepts exact renames and rejects anything else", () => {
    const root = fixtureRepo({ "source.ts": VALUE });
    fixtureGit(root, "mv", "source.ts", "target.ts");
    const declared = [move("source.ts", "target.ts", VALUE)];
    expect(() => assertExactMoveDiff(stagedDiff(root), declared, root)).not.toThrow();
    expect(() => assertExactMoveDiff("M\tsource.ts\n", declared, root)).toThrow("R100");
    expect(() => assertExactScope(["source.ts", "target.ts"], ["source.ts", "target.ts"])).not.toThrow();
    expect(() => assertExactScope(["source.ts", "extra.ts"], ["source.ts"])).toThrow("outside");
  }, 60_000);

  test("rejects a reported source the plan never declared", () => {
    // Same cardinality, same targets, every line R100 — only the sources
    // differ. Crossing among identical blobs never invents a source, so this is
    // the case the multiset check exists to catch, and the one an assertion on
    // pairs would have caught by accident.
    const root = fixtureRepo({ "source.ts": VALUE });
    const declared = [move("source.ts", "target.ts", VALUE)];
    expect(() => assertExactMoveDiff("R100\tstranger.ts\ttarget.ts\n", declared, root)).toThrow("declared move");
  }, 60_000);

  test("rejects an extra staged path the plan never declared", () => {
    const root = fixtureRepo({ "source.ts": VALUE, "extra.ts": "export const extra = 2;\n" });
    fixtureGit(root, "mv", "source.ts", "target.ts");
    fixtureGit(root, "mv", "extra.ts", "moved-extra.ts");
    expect(() => assertExactMoveDiff(stagedDiff(root), [move("source.ts", "target.ts", VALUE)], root)).toThrow(
      "declared move",
    );
  }, 60_000);

  test("rejects a move whose content changed on the way", () => {
    // git reports D + A rather than R100 once the bytes differ at 100%
    // similarity, so the status check is what fails here.
    const root = fixtureRepo({ "source.ts": VALUE });
    fixtureGit(root, "mv", "source.ts", "target.ts");
    write(root, "target.ts", `${VALUE}export const sneaked = 2;\n`);
    fixtureGit(root, "add", "--", "target.ts");
    expect(() => assertExactMoveDiff(stagedDiff(root), [move("source.ts", "target.ts", VALUE)], root)).toThrow("R100");
  }, 60_000);

  test("rejects landed bytes that do not match the declared result hash", () => {
    // The staged rename is untouched, so git still reports a clean R100 and the
    // multisets still agree: only the tool's own hash of the landed file
    // notices. Without this check nothing here would fail.
    const root = fixtureRepo({ "source.ts": VALUE });
    fixtureGit(root, "mv", "source.ts", "target.ts");
    const diff = stagedDiff(root);
    expect(diff).toContain("R100");
    write(root, "target.ts", `${VALUE}export const sneaked = 2;\n`);
    expect(() => assertExactMoveDiff(diff, [move("source.ts", "target.ts", VALUE)], root)).toThrow(
      "do not match the plan",
    );
  }, 60_000);

  test("rejects a declared move that did not happen", () => {
    const root = fixtureRepo({ "source.ts": VALUE, "other.ts": "export const other = 2;\n" });
    fixtureGit(root, "mv", "source.ts", "target.ts");
    const declared = [
      move("source.ts", "target.ts", VALUE),
      move("other.ts", "other-target.ts", "export const other = 2;\n"),
    ];
    expect(() => assertExactMoveDiff(stagedDiff(root), declared, root)).toThrow("declared move");
    expect(existsSync(join(root, "other.ts"))).toBe(true);
    expect(existsSync(join(root, "other-target.ts"))).toBe(false);
  }, 60_000);
});
