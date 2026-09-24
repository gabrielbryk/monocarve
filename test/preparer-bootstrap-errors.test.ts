import { describe, expect, test } from "bun:test";

import { reconcileBootstrapOutcome } from "../src/preparer/bootstrap.ts";
import { PreparerError } from "../src/preparer/core.ts";

describe("bootstrap outcome/cleanup reconciliation", () => {
  test("surfaces the original try-body error, not a cleanup failure, when both fail", () => {
    const bodyError = new PreparerError("bootstrap commit requires the exact manifest baseline at HEAD");

    let thrown: unknown;
    try {
      reconcileBootstrapOutcome({ kind: "failure", error: bodyError }, ["packages/leads/src/view.ts"]);
    } catch (error) {
      thrown = error;
    }

    // The exact original error instance surfaces — it is not replaced.
    expect(thrown).toBe(bodyError);
    expect((thrown as PreparerError).message).toBe("bootstrap commit requires the exact manifest baseline at HEAD");
    // The cleanup failure is not lost either: it is attached as the cause.
    expect((thrown as PreparerError).cause).toBeInstanceOf(PreparerError);
    expect(((thrown as PreparerError).cause as PreparerError).message).toContain("bootstrap output rollback was incomplete");
    expect(((thrown as PreparerError).cause as PreparerError).message).toContain("packages/leads/src/view.ts");
  });

  test("still reports a cleanup failure after a successful body", () => {
    let thrown: unknown;
    try {
      reconcileBootstrapOutcome({ kind: "success", result: "deadbeef" }, ["packages/leads/src/view.ts"]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PreparerError);
    expect((thrown as PreparerError).message).toContain("bootstrap output rollback was incomplete");
    expect((thrown as PreparerError).message).toContain("packages/leads/src/view.ts");
  });

  test("returns the body's result when both the body and cleanup succeed", () => {
    expect(reconcileBootstrapOutcome({ kind: "success", result: "deadbeef" }, [])).toBe("deadbeef");
  });

  test("propagates the original error untouched when cleanup succeeds", () => {
    const bodyError = new PreparerError("preparer manifest does not declare a bootstrap config");

    let thrown: unknown;
    try {
      reconcileBootstrapOutcome({ kind: "failure", error: bodyError }, []);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(bodyError);
    expect((thrown as PreparerError).cause).toBeUndefined();
  });
});
