import type { ExtractionManifest, GeneratedFileRecord, MoveOperation, MoveWithRewriteOperation, PlanOperation } from "./manifest.ts";

function isMove(operation: PlanOperation): operation is MoveOperation {
  return operation.kind === "move";
}
export function isAnyMove(operation: PlanOperation): operation is MoveOperation | MoveWithRewriteOperation {
  return operation.kind === "move" || operation.kind === "move-with-rewrite";
}
export function operationTargets(operation: PlanOperation): string[] {
  switch (operation.kind) {
    case "move":
    case "move-with-rewrite":
      return [operation.target];
    case "rewrite-import":
      return [operation.file];
    case "rewrite-fs-reference":
      return [operation.file];
    case "rewrite-path-reference":
      return [operation.file];
    case "write-file":
      return [operation.path];
    case "delete-file":
      return [operation.path];
    case "lockfile-importer":
      return [operation.lockfile];
    case "migrate-path-keys":
      return [operation.path];
  }
}
function operationSources(operation: PlanOperation): string[] {
  return operation.kind === "move" || operation.kind === "move-with-rewrite" ? [operation.source] : [];
}
export function operationPaths(operation: PlanOperation): string[] {
  return [...operationSources(operation), ...operationTargets(operation)];
}
export function manifestPaths(manifest: ExtractionManifest): string[] {
  return [...new Set(manifest.operations.flatMap(operationPaths))].toSorted();
}
export function pureRenames(manifest: ExtractionManifest): MoveOperation[] {
  return manifest.operations.filter(isMove);
}
export function regeneratedArtifacts(manifest: ExtractionManifest): GeneratedFileRecord[] {
  return manifest.generatedFiles.filter((generated) => generated.regenerateOnApply === true);
}
export function regeneratedArtifactPaths(manifest: ExtractionManifest): string[] {
  return [
    ...new Set([
      ...regeneratedArtifacts(manifest).map((generated) => generated.path),
      ...(manifest.postJournalPreparers ?? []).flatMap((preparer) => preparer.outputs),
    ]),
  ].toSorted();
}
export function planSensitivePaths(manifest: ExtractionManifest): readonly string[] {
  return [
    ...manifestPaths(manifest),
    ...regeneratedArtifactPaths(manifest),
    ...manifest.changedFiles,
    ...Object.keys(manifest.sourceBlobs),
    ...manifest.source.files,
    ...manifest.source.tests,
    ...(manifest.source.assets ?? []),
    ...manifest.consumers.map((consumer) => consumer.file),
    ...manifest.generatedFiles.flatMap((artifact) => [artifact.path, artifact.source]),
  ];
}
export function wiringPaths(manifest: ExtractionManifest): string[] {
  return [
    ...new Set([
      ...manifest.operations.flatMap((operation) => (operation.kind === "move" ? [] : operationPaths(operation))),
      ...regeneratedArtifactPaths(manifest),
    ]),
  ];
}
