/** Deterministic, syntax-aware extraction of selector declaration order. */

export interface CssRuleSurface { readonly selector: string; readonly properties: readonly string[] }

export function cssRuleSurface(source: string): readonly CssRuleSurface[] {
  return parseRange(source, 0, source.length);
}

function parseRange(source: string, start: number, end: number): CssRuleSurface[] {
  const rules: CssRuleSurface[] = [];
  let cursor = start;
  while (cursor < end) {
    cursor = skipTrivia(source, cursor, end);
    if (cursor >= end) break;
    const open = findToken(source, cursor, end, "{");
    if (open < 0) break;
    const close = matchingBrace(source, open, end);
    if (close < 0) break;
    const prelude = source.slice(cursor, open).trim();
    if (prelude.startsWith("@")) {
      if (isContainerAtRule(prelude)) rules.push(...parseRange(source, open + 1, close));
    } else if (prelude !== "") {
      const properties = directProperties(source, open + 1, close);
      for (const selector of splitTopLevel(prelude, ",")) {
        const normalized = selector.trim();
        if (normalized !== "") rules.push({ selector: normalized, properties });
      }
      // CSS nesting is legal; nested selectors are additional surface.
      rules.push(...nestedRules(source, open + 1, close));
    }
    cursor = close + 1;
  }
  return rules;
}

function nestedRules(source: string, start: number, end: number): CssRuleSurface[] {
  const first = findToken(source, start, end, "{");
  if (first < 0) return [];
  let boundary = first;
  while (boundary > start && source[boundary - 1] !== ";" && source[boundary - 1] !== "}") boundary--;
  return parseRange(source, boundary, end);
}

function directProperties(source: string, start: number, end: number): string[] {
  const prefixEnd = findToken(source, start, end, "{");
  const text = source.slice(start, prefixEnd < 0 ? end : prefixEnd);
  return splitTopLevel(text, ";").flatMap((part) => {
    const colon = findToken(part, 0, part.length, ":");
    if (colon < 0) return [];
    const property = part.slice(0, colon).trim();
    return property === "" || property.startsWith("@") ? [] : [property];
  });
}

function isContainerAtRule(prelude: string): boolean {
  return /^@(media|supports|layer|container|scope|document)\b/u.test(prelude);
}

function splitTopLevel(source: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let parens = 0;
  for (let index = 0; index < source.length; index++) {
    const skipped = skipQuotedOrComment(source, index, source.length);
    if (skipped !== index) { index = skipped - 1; continue; }
    const char = source[index];
    if (char === "(") parens++;
    else if (char === ")") parens = Math.max(0, parens - 1);
    else if (char === separator && parens === 0) { parts.push(source.slice(start, index)); start = index + 1; }
  }
  parts.push(source.slice(start));
  return parts;
}

function matchingBrace(source: string, open: number, end: number): number {
  let depth = 1;
  for (let index = open + 1; index < end; index++) {
    const skipped = skipQuotedOrComment(source, index, end);
    if (skipped !== index) { index = skipped - 1; continue; }
    if (source[index] === "{") depth++;
    else if (source[index] === "}" && --depth === 0) return index;
  }
  return -1;
}

function findToken(source: string, start: number, end: number, token: string): number {
  let parens = 0;
  for (let index = start; index < end; index++) {
    const skipped = skipQuotedOrComment(source, index, end);
    if (skipped !== index) { index = skipped - 1; continue; }
    if (source[index] === "(") parens++;
    else if (source[index] === ")") parens = Math.max(0, parens - 1);
    else if (source[index] === token && parens === 0) return index;
  }
  return -1;
}

function skipTrivia(source: string, start: number, end: number): number {
  let cursor = start;
  while (cursor < end) {
    if (/\s/u.test(source[cursor] ?? "")) { cursor++; continue; }
    if (source.startsWith("/*", cursor)) {
      const close = source.indexOf("*/", cursor + 2);
      cursor = close < 0 ? end : Math.min(end, close + 2);
      continue;
    }
    break;
  }
  return cursor;
}

function skipQuotedOrComment(source: string, index: number, end: number): number {
  if (source.startsWith("/*", index)) {
    const close = source.indexOf("*/", index + 2);
    return close < 0 ? end : close + 2;
  }
  const quote = source[index];
  if (quote !== "\"" && quote !== "'") return index;
  for (let cursor = index + 1; cursor < end; cursor++) {
    if (source[cursor] === "\\") cursor++;
    else if (source[cursor] === quote) return cursor + 1;
  }
  return end;
}
