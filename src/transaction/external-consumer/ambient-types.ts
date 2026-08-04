import { existsSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

import { TOOL_NAME } from "../../branding.ts";

/** Separate `types` entries from plain module declarations that must be root files. */
export function partitionTypes(
  names: readonly string[],
  installedRoot: string,
  options: ts.CompilerOptions,
): { readonly types: string[]; readonly ambient: string[] } {
  const host = ts.createCompilerHost(options, true);
  const containingFile = join(installedRoot, `__${TOOL_NAME}_types__.ts`);
  return names.reduce<{ types: string[]; ambient: string[] }>((partition, name) => {
    const typeReference = ts.resolveTypeReferenceDirective(name, containingFile, options, host).resolvedTypeReferenceDirective;
    if (typeReference?.resolvedFileName) partition.types.push(name);
    else addAmbientModule(partition, name, containingFile, options, host);
    return partition;
  }, { types: [], ambient: [] });
}

function addAmbientModule(
  partition: { types: string[]; ambient: string[] },
  name: string,
  containingFile: string,
  options: ts.CompilerOptions,
  host: ts.CompilerHost,
): void {
  const fallback = ts.resolveModuleName(name, containingFile, { ...options, types: [] }, host).resolvedModule?.resolvedFileName;
  if (fallback !== undefined && fallback.endsWith(".d.ts") && existsSync(fallback)) partition.ambient.push(fallback);
  else partition.types.push(name);
}
