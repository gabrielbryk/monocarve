import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { TOOL_NAME } from "../branding.ts";

/** Private, disk-backed scratch for short-lived analytical snapshots. */
export function scratchRoot(): string {
  const configured = process.env.TMPDIR;
  const root = configured && configured !== tmpdir()
    ? resolve(configured)
    : join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), TOOL_NAME, "tmp");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}
