/**
 * The digest that binds a plan or preparer manifest to the configuration it
 * was compiled against.
 *
 * Not simply `hashJson(config)`. `transaction.worktreeRoot` is a machine-local
 * scratch path — where this host happens to build disposable simulation
 * worktrees — and it has no bearing on what a plan contains or what applying it
 * does. Including it made a plan's identity depend on the filesystem of the
 * machine that compiled it: two developers whose `TMPDIR` differed computed
 * different digests for the same plan, and a plan compiled before a scratch
 * root changed was rejected as forged afterwards.
 *
 * That is not a theoretical concern. It is exactly how `configDigest`
 * validation broke when the default scratch root moved off `/tmp`: a plan
 * compiled in one process and validated by a spawned CLI that resolved a
 * different root disagreed, and `assertPlanValid` reported "plan configuration
 * digest does not match the effective configuration" for a plan nobody had
 * touched.
 *
 * Every other field stays in. A plan's meaning does depend on package roots,
 * applications, scaffold templates, gates and the rest, and a digest that
 * ignored them would not be worth computing.
 */

import { hashJson, type Sha256 } from "../util/hash.ts";
import type { MonocarveConfig } from "./schema.ts";

/** SHA-256 identity of a validated config, excluding machine-local `transaction.worktreeRoot`. */
export function configDigest(config: MonocarveConfig): Sha256 {
  // Destructured out rather than deleted from a clone, so adding a field to
  // the transaction block cannot silently fall out of the digest.
  const { worktreeRoot: _machineLocal, ...transaction } = config.transaction;
  return hashJson({ ...config, transaction });
}
