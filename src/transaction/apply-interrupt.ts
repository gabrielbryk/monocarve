/**
 * SIGINT/SIGTERM handling for a committing apply.
 *
 * Without a handler the default action kills the process wherever it is, which
 * for a committing apply means mid-journal with the lock still held. While the
 * checkout is being mutated the guard is armed with the same rollback point
 * that was durably checkpointed; an interrupt restores it synchronously,
 * releases the lock, and exits with 128 + the signal number. Outside the
 * mutating window it only releases the lock. A handler is a JavaScript
 * callback, so it runs at the next event-loop turn; the journal yields after
 * every operation to make that turn arrive between operations.
 */
import { TOOL_NAME } from "../branding.ts";
import { restoreRollbackPoint } from "./apply-checkpoint.ts";
import { errorText } from "./apply-owner.ts";
import type { ApplyTransactionHandle } from "./apply-state.ts";
import type { RollbackPoint } from "./rollback.ts";

export type GuardedSignal = "SIGINT" | "SIGTERM";

const SIGNAL_NUMBERS: Readonly<Record<GuardedSignal, number>> = { SIGINT: 2, SIGTERM: 15 };
const GUARDED_SIGNALS: readonly GuardedSignal[] = ["SIGINT", "SIGTERM"];

export interface InterruptRuntime {
  on(signal: GuardedSignal, listener: () => void): void;
  off(signal: GuardedSignal, listener: () => void): void;
  exit(code: number): void;
  report(text: string): void;
}

export interface InterruptGuard {
  /** The checkout is about to be mutated; an interrupt must restore `point`. */
  arm(point: RollbackPoint): void;
  /** The mutating window ended through normal return or in-process rollback. */
  disarm(): void;
  dispose(): void;
}

const processRuntime: InterruptRuntime = {
  on: (signal, listener) => process.on(signal, listener),
  off: (signal, listener) => process.off(signal, listener),
  exit: (code) => process.exit(code),
  report: (text) => process.stderr.write(text),
};

export function guardInterrupts(rootDir: string, transaction: ApplyTransactionHandle, runtime: InterruptRuntime = processRuntime): InterruptGuard {
  let armed: RollbackPoint | undefined;
  let handled = false;
  const listeners = new Map<GuardedSignal, () => void>();

  const interrupt = (signal: GuardedSignal): void => {
    if (handled) return;
    handled = true;
    let outcome: string;
    try {
      outcome = armed === undefined ? settleUnarmed(transaction) : restoreArmed(rootDir, transaction, armed);
    } catch (error) {
      outcome = `interrupt recovery failed (${errorText(error)}); run ${TOOL_NAME} apply-status`;
    }
    try {
      transaction.release();
    } catch (error) {
      outcome = `${outcome}; lock release failed (${errorText(error)})`;
    }
    runtime.report(`${TOOL_NAME}: apply interrupted by ${signal}; ${outcome}\n`);
    runtime.exit(128 + SIGNAL_NUMBERS[signal]);
  };

  for (const signal of GUARDED_SIGNALS) {
    const listener = (): void => interrupt(signal);
    listeners.set(signal, listener);
    runtime.on(signal, listener);
  }

  return {
    arm: (point) => {
      armed = point;
    },
    disarm: () => {
      armed = undefined;
    },
    dispose: () => {
      for (const [signal, listener] of listeners) runtime.off(signal, listener);
      listeners.clear();
    },
  };
}

function restoreArmed(rootDir: string, transaction: ApplyTransactionHandle, point: RollbackPoint): string {
  const result = restoreRollbackPoint(rootDir, point);
  if (result.ok) {
    transaction.complete();
    return `rolled back: ${result.message}`;
  }
  // Keep the state and checkpoint, marked as an interrupted journal, so
  // apply-recover retries exactly this restore.
  transaction.update("applying");
  return `${result.message}; run ${TOOL_NAME} apply-recover --plan ${JSON.stringify(transaction.state.manifestPath)}`;
}

function settleUnarmed(transaction: ApplyTransactionHandle): string {
  if (transaction.state.phase === "simulating") {
    transaction.complete();
    return "no checkout mutation had started; lock released";
  }
  return `checkout left at phase ${transaction.state.phase}; run ${TOOL_NAME} apply-status`;
}
