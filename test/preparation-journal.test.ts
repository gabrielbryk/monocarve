import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HashMismatchError } from "../src/errors.ts";
import {
  executePreparationJournal,
  rollbackCompletedPreparationJournal,
  verifyPreparationOperations,
  type PreparationFilesystemOperation,
} from "../src/prepare/journal.ts";
import { hashText, MISSING } from "../src/util/hash.ts";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("preparation journal", () => {
  for (const failureIndex of [0, 1, 2, 3, 4]) {
    test(`restores every touched kind when operation ${failureIndex} fails`, () => {
      const root = fixtureRoot();
      seed(root);
      const before = state(root);

      expect(() => executePreparationJournal({
        rootDir: root,
        operations: operations(),
        beforeOperation(index) {
          if (index === failureIndex) throw new Error(`injected preparation failure ${index}`);
        },
      })).toThrow(`injected preparation failure ${failureIndex}`);

      // This would fail if rollback forgot a file's bytes/mode, a deleted file,
      // a replaced symlink, or the directories created for a rendered output.
      expect(state(root)).toEqual(before);
      expect(existsSync(join(root, "created"))).toBe(false);
    });
  }

  test("rejects a stale precondition before it writes any path", () => {
    const root = fixtureRoot();
    seed(root);
    writeFileSync(join(root, "replace.ts"), "concurrent edit");
    const before = state(root);

    expect(() => verifyPreparationOperations(root, operations())).toThrow(HashMismatchError);
    expect(state(root)).toEqual(before);
  });

  test("rejects bytes that do not match the rendered result proof before it writes", () => {
    const root = fixtureRoot();
    seed(root);
    const before = state(root);
    const invalid = [{ ...operations()[0]!, contents: "unproved bytes" }, ...operations().slice(1)] as const;

    expect(() => executePreparationJournal({ rootDir: root, operations: invalid })).toThrow(HashMismatchError);
    expect(state(root)).toEqual(before);
  });

  test("a concurrent edit before a later operation is neither overwritten nor rolled back", () => {
    const root = fixtureRoot();
    seed(root);

    expect(() => executePreparationJournal({
      rootDir: root,
      operations: operations(),
      beforeOperation(index, operation) {
        if (index === 1) writeFileSync(join(root, operation.path), "concurrent edit");
      },
    })).toThrow("compare-and-swap failed for delete.ts");

    expect(readFileSync(join(root, "replace.ts"), "utf8")).toBe("original");
    expect(readFileSync(join(root, "delete.ts"), "utf8")).toBe("concurrent edit");
  });

  test("an edit injected after validation but before ownership transfer is preserved and refused", () => {
    const root = fixtureRoot();
    seed(root);

    expect(() => executePreparationJournal({
      rootDir: root,
      operations: [operations()[0]!],
      beforeOwnershipTransfer() {
        writeFileSync(join(root, "replace.ts"), "late concurrent replacement");
        chmodSync(join(root, "replace.ts"), 0o751);
      },
    })).toThrow("ownership verification failed for replace.ts");

    expect(readFileSync(join(root, "replace.ts"), "utf8")).toBe("late concurrent replacement");
    expect(Number(lstatSync(join(root, "replace.ts")).mode) & 0o777).toBe(0o751);
  });

  test("rollback reports residue instead of overwriting a concurrent edit to a journal output", () => {
    const root = fixtureRoot();
    seed(root);
    let caught: Error | undefined;

    try {
      executePreparationJournal({
        rootDir: root,
        operations: operations(),
        beforeOperation(index) {
          if (index !== 1) return;
          writeFileSync(join(root, "replace.ts"), "concurrent edit after operation zero");
          throw new Error("injected later failure");
        },
      });
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toContain("PREPARATION JOURNAL RESTORE INCOMPLETE");
    expect(caught?.message).toContain("replace.ts");
    expect(readFileSync(join(root, "replace.ts"), "utf8")).toBe("concurrent edit after operation zero");
  });

  test("a donor rewrite preserves the executable mode proven by its result", () => {
    const root = fixtureRoot();
    seed(root);
    const operation: PreparationFilesystemOperation = {
      kind: "write",
      path: "replace.ts",
      contents: "replacement",
      preconditionHash: hashText("original"),
      preconditionMode: 0o755,
      resultHash: hashText("replacement"),
      resultMode: 0o755,
    };

    executePreparationJournal({ rootDir: root, operations: [operation] });

    expect(readFileSync(join(root, "replace.ts"), "utf8")).toBe("replacement");
    expect(Number(lstatSync(join(root, "replace.ts")).mode) & 0o777).toBe(0o751);
  });

  test("a completed journal exposes CAS-aware recovery for a later-stage failure", () => {
    const root = fixtureRoot();
    seed(root);
    const result = executePreparationJournal({ rootDir: root, operations: [operations()[0]!] });

    const report = rollbackCompletedPreparationJournal(result.recovery);

    expect(report.residue).toEqual([]);
    expect(readFileSync(join(root, "replace.ts"), "utf8")).toBe("original");
    expect(Number(lstatSync(join(root, "replace.ts")).mode) & 0o777).toBe(0o751);
  });

  test("completed-journal recovery refuses to overwrite post-journal edits", () => {
    const root = fixtureRoot();
    seed(root);
    const result = executePreparationJournal({ rootDir: root, operations: [operations()[0]!] });
    writeFileSync(join(root, "replace.ts"), "post-journal edit");

    const report = rollbackCompletedPreparationJournal(result.recovery);

    expect(report.residue).toEqual(["replace.ts"]);
    expect(readFileSync(join(root, "replace.ts"), "utf8")).toBe("post-journal edit");
  });

  test("rejects an escaping path before it writes the valid operation", () => {
    const root = fixtureRoot();
    seed(root);
    const before = state(root);
    const invalid = [{ ...operations()[0]!, path: "../outside.ts" }, operations()[1]!] as const;

    expect(() => executePreparationJournal({ rootDir: root, operations: invalid })).toThrow("workspace-relative");
    expect(state(root)).toEqual(before);
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "monocarve-preparation-journal-"));
  roots.push(root);
  return root;
}

function seed(root: string): void {
  writeFileSync(join(root, "replace.ts"), "original");
  chmodSync(join(root, "replace.ts"), 0o751);
  writeFileSync(join(root, "delete.ts"), "remove me");
  // Git proves this as 0644 even when the checkout's umask leaves group-write.
  chmodSync(join(root, "delete.ts"), 0o664);
  writeFileSync(join(root, "target.ts"), "target");
  symlinkSync("target.ts", join(root, "link.ts"));
}

function operations(): readonly PreparationFilesystemOperation[] {
  return [
    { kind: "write", path: "replace.ts", contents: "replacement", preconditionHash: hashText("original"), preconditionMode: 0o755, resultHash: hashText("replacement"), resultMode: 0o644 },
    { kind: "delete", path: "delete.ts", preconditionHash: hashText("remove me"), preconditionMode: 0o644 },
    { kind: "write", path: "link.ts", contents: "replacement link", preconditionHash: hashText("target.ts"), preconditionMode: 0o755, resultHash: hashText("replacement link"), resultMode: 0o644 },
    { kind: "write", path: "created/deep/output.ts", contents: "new file", preconditionHash: MISSING, preconditionMode: MISSING, resultHash: hashText("new file"), resultMode: 0o644 },
    { kind: "delete", path: "last.ts", preconditionHash: MISSING, preconditionMode: MISSING },
  ];
}

function state(root: string): Record<string, unknown> {
  return {
    replace: { contents: readFileSync(join(root, "replace.ts"), "utf8"), mode: Number(lstatSync(join(root, "replace.ts")).mode) & 0o777 },
    deleted: readFileSync(join(root, "delete.ts"), "utf8"),
    link: { target: readlinkSync(join(root, "link.ts")), isSymlink: lstatSync(join(root, "link.ts")).isSymbolicLink() },
    created: existsSync(join(root, "created/deep/output.ts")),
  };
}
