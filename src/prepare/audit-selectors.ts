/** Selector-integrity proof: every declaration selector names one physical type declaration in the baseline donor. */
import ts from "typescript";

import { hashJson, hashText } from "../util/hash.ts";
import type { PreparationDeclarationSelector } from "./manifest-types.ts";

export function verifySelectors(selectors: readonly PreparationDeclarationSelector[], baselines: ReadonlyMap<string, Uint8Array>, failures: string[]): void {
  const seen: SeenSelectors = { ids: new Set(), selectorIds: new Set(), spans: new Set() };
  for (const selector of selectors) {
    verifySelectorUniqueness(selector, seen, failures);
    // A loaded manifest is untrusted JSON: its declared types do not prove the space it carries.
    if (selector.space !== "type" || !isTypeKind(selector.kind)) {
      failures.push(`selector is not type-only: ${selector.sourcePath}:${selector.name}`);
    }
    const baseline = baselines.get(selector.sourcePath);
    if (baseline === undefined) failures.push(`selector donor was not replayed: ${selector.sourcePath}`);
    else verifySelectorAgainstBaseline(selector, new TextDecoder().decode(baseline), failures);
  }
}

interface SeenSelectors {
  readonly ids: Set<string>;
  readonly selectorIds: Set<string>;
  readonly spans: Set<string>;
}

function verifySelectorUniqueness(selector: PreparationDeclarationSelector, seen: SeenSelectors, failures: string[]): void {
  if (seen.ids.has(selector.declarationId)) failures.push(`selector names declaration more than once: ${selector.declarationId}`);
  seen.ids.add(selector.declarationId);
  if (seen.selectorIds.has(selector.selectorId)) failures.push(`selector removal recipe appears more than once: ${selector.selectorId}`);
  seen.selectorIds.add(selector.selectorId);
  const spanKey = `${selector.sourcePath}:${selector.span.start}:${selector.span.end}`;
  if (seen.spans.has(spanKey)) failures.push(`selector claims a physical span more than once: ${spanKey}`);
  seen.spans.add(spanKey);
}

/** Checks run in order; a span or extraction region that cannot be read ends the checks for this selector. */
function verifySelectorAgainstBaseline(selector: PreparationDeclarationSelector, text: string, failures: string[]): void {
  const label = `${selector.sourcePath}:${selector.name}`;
  if (hashText(text) !== selector.sourceHash) failures.push(`selector source hash differs: ${label}`);
  if (selector.selectorId !== removalIdentity(selector)) failures.push(`selector removal identity differs: ${label}`);
  if (selector.span.start < 0 || selector.span.end <= selector.span.start || selector.span.end > text.length) {
    failures.push(`selector span is outside baseline donor: ${label}`);
    return;
  }
  if (hashText(text.slice(selector.span.start, selector.span.end)) !== selector.span.hash) failures.push(`selector span hash differs: ${label}`);
  if (extractionOutsideText(selector, text.length)) {
    failures.push(`selector extraction region is outside baseline donor: ${label}`);
    return;
  }
  if (hashText(text.slice(selector.extractionStart, selector.extractionEnd)) !== selector.extractionHash) {
    failures.push(`selector extraction hash differs: ${label}`);
    return;
  }
  const source = ts.createSourceFile(selector.sourcePath, text, ts.ScriptTarget.Latest, true);
  const statement = source.statements.find((item) => item.getStart(source) === selector.span.start && item.end === selector.span.end);
  if (!statement || statement.getFullStart() !== selector.extractionStart || statement.end !== selector.extractionEnd) {
    failures.push(`selector extraction region is not one full declaration: ${label}`);
  }
}

function removalIdentity(selector: PreparationDeclarationSelector): string {
  return hashJson({
    declarationId: selector.declarationId,
    sourcePath: selector.sourcePath,
    sourceHash: selector.sourceHash,
    extractionStart: selector.extractionStart,
    extractionEnd: selector.extractionEnd,
    extractionHash: selector.extractionHash,
  });
}

function extractionOutsideText(selector: PreparationDeclarationSelector, length: number): boolean {
  return (
    selector.extractionStart < 0 ||
    selector.extractionEnd < selector.span.end ||
    selector.extractionStart > selector.span.start ||
    selector.extractionEnd > length
  );
}

function isTypeKind(kind: PreparationDeclarationSelector["kind"]): boolean {
  return kind === "interface" || kind === "type-alias";
}
