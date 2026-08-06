/** Deterministic build-owned revision evidence, separate from target workspace planning. */
import { tryGit } from "../src/util/git.ts";

export function buildSourceRevision(toolRoot: string): string | undefined {
  const revision = tryGit({ cwd: toolRoot }, "rev-parse", "HEAD") ?? undefined;
  return revision !== undefined && /^[0-9a-f]{40,64}$/.test(revision) ? revision : undefined;
}
