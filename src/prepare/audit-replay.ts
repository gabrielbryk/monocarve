/** Re-derive preparation bytes from immutable baseline evidence, never output text. */

import { byCodeUnit, hashJson } from "../util/hash.ts";
import type { ExtractTypeDeclarationsOperation, PreparationDeclarationSelector } from "./manifest-types.ts";
import { PreparationReplayError, renderTypeOnlyExtraction } from "./replay.ts";

export function verifyRenderedReplay(operation: ExtractTypeDeclarationsOperation, baseline: Uint8Array | undefined, failures: string[]): void {
  if (baseline === undefined) return;
  const source = new TextDecoder().decode(baseline);
  try {
    const replay = renderTypeOnlyExtraction({
      baselineText: source,
      baselineHash: operation.donor.preconditionHash,
      selected: operation.declarations
        .flatMap((group) => group.declarations)
        .map((selector) => ({
          start: selector.extractionStart,
          end: selector.extractionEnd,
          hash: selector.extractionHash,
          name: selector.name,
          kind: replayKind(selector),
          originallyExported: selector.originallyExported,
        })),
      targetPath: operation.target.path,
      moduleSpecifier: operation.moduleSpecifier,
      targetImports: operation.targetImports,
      inlineImportTypeProofs: operation.inlineImportTypeProofs ?? [],
      compatibility: { reExportNames: operation.reExportNames, donorImports: operation.donorImports },
    });
    if (replay.donor.text !== operation.donorContents || replay.donor.hash !== operation.donor.resultHash) {
      failures.push(`replay does not reproduce donor bytes: ${operation.donor.path}`);
    }
    if (replay.target.text !== operation.targetContents || replay.target.hash !== operation.target.resultHash) {
      failures.push(`replay does not reproduce target bytes: ${operation.target.path}`);
    }
    const selectorIds = new Map(
      operation.declarations.flatMap((group) =>
        group.declarations.map((selector) => [`${selector.extractionStart}:${selector.extractionEnd}:${selector.extractionHash}`, selector.selectorId]),
      ),
    );
    const expected = replay.declarations
      .map((item) => ({
        selectorId: selectorIds.get(`${item.source.start}:${item.source.end}:${item.source.hash}`),
        targetStart: item.targetSpan.start,
        targetEnd: item.targetSpan.end,
        targetHash: item.targetSpan.hash,
        targetExtractionStart: item.targetExtraction.start,
        targetExtractionEnd: item.targetExtraction.end,
        targetExtractionHash: item.targetExtraction.hash,
        synthesizedExport: item.synthesizedExport,
      }))
      .toSorted((left, right) => byCodeUnit(left.selectorId ?? "", right.selectorId ?? ""));
    const actual = operation.targetDeclarationProofs.map((item) => ({ ...item }));
    if (expected.some((item) => item.selectorId === undefined) || hashJson(expected) !== hashJson(actual)) {
      failures.push(`replay does not reproduce target declaration proofs: ${operation.target.path}`);
    }
  } catch (error) {
    failures.push(`replay refused manifest evidence for ${operation.donor.path}: ${(error as Error).message}`);
  }
}

function replayKind(selector: PreparationDeclarationSelector): "interface" | "type-alias" {
  if (selector.kind === "interface" || selector.kind === "type-alias") return selector.kind;
  throw new PreparationReplayError(`selector ${selector.name} is not a type-only declaration`);
}
