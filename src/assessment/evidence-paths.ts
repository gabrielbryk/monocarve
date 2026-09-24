import { isPathInside } from "../util/paths.ts";

export function systemReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function overlaps(left: string, right: string): boolean {
  return isPathInside(left, right) || isPathInside(right, left);
}
