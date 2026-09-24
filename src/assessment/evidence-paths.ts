import { isAbsolute, relative } from "node:path";

export function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}

export function systemReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function overlaps(left: string, right: string): boolean {
  return within(left, right) || within(right, left);
}
