/**
 * The path-shaped token rule, shared.
 *
 * Why this lives in its own module: `path-references.ts` warns about a
 * path-shaped string it cannot resolve, and `path-reference-rewrites.ts`
 * rewrites a path-shaped string it can. Those are two different questions
 * asked over the same tokenizer, and they must agree byte-for-byte on what
 * counts as a token — the normalization, the extension handling, the
 * segment-count floor. If the two modules each grew their own copy of this
 * rule, a divergence between them would mean the engine rewrites something
 * it never warned about, or warns about something it silently already
 * rewrote. One tokenizer, two consumers, is how that risk is closed off by
 * construction rather than by discipline.
 */

import { extname } from "node:path";

/**
 * Maximal runs of characters a path may be spelled with. Deliberately excludes
 * `:`, `*`, whitespace and quotes, so `"chart.ts:12"` yields the path and the
 * line number separately, and a sentence containing a path yields the path.
 */
export const PATH_TOKEN = /[A-Za-z0-9_@.\-\\/]+/g;

/**
 * A token reduced to the form a workspace-relative path is written in, or null
 * when it cannot be one.
 *
 * `..` rejects the token outright rather than resolving it: a relative literal
 * has a base this scanner does not know (the file's directory is a guess — the
 * process's cwd is just as likely), and resolving it against the wrong base
 * would manufacture a path that appears nowhere in the repository.
 *
 * `prefixLength` is the number of characters trimmed from the *start* of
 * `raw` to reach `path` — everything before it ("https://", "./", a second
 * leading slash, anything) is a byte the caller must never touch. It is
 * expressed in the raw token's own coordinate space: `raw.replaceAll("\\",
 * "/")` never changes string length or shifts offsets (backslash and slash
 * are both one character), so a count taken against the slash-normalized
 * `value` is valid against `raw` unmodified — a rewriter can slice `raw`
 * directly at `prefixLength` without re-deriving anything.
 */
export function normalizeToken(
  raw: string,
): { readonly path: string; readonly absolute: boolean; readonly prefixLength: number } | null {
  let value = raw.replaceAll("\\", "/");
  const absolute = value.startsWith("/");
  let prefixLength = 0;
  while (value.startsWith("./")) {
    value = value.slice(2);
    prefixLength += 2;
  }
  while (value.startsWith("/")) {
    value = value.slice(1);
    prefixLength += 1;
  }
  while (value.endsWith("/")) value = value.slice(0, -1);
  if (!value.includes("/")) return null;
  if (value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  return { path: value, absolute, prefixLength };
}

/**
 * Index keys for a token: the token itself, plus — for an absolute token only —
 * every segment-aligned suffix long enough to clear `minSegments`.
 */
export function keysFor(segments: readonly string[], absolute: boolean, minSegments: number): string[] {
  const last = absolute ? segments.length - minSegments : 0;
  const keys: string[] = [];
  for (let start = 0; start <= last; start += 1) keys.push(segments.slice(start).join("/"));
  return keys.filter((key) => segmentCount(key) >= minSegments);
}

export function segmentCount(path: string): number {
  return path.split("/").length;
}

export function stripExtension(path: string): string {
  const extension = extname(path);
  return extension === "" ? path : path.slice(0, path.length - extension.length);
}
