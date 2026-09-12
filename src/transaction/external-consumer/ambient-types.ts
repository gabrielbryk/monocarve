import { existsSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

import { TOOL_NAME } from "../../branding.ts";

/**
 * Separate `types` entries from plain module declarations that must be root
 * files.
 *
 * `owners` lists every directory a `node_modules` lookup for this extraction
 * could plausibly start from (every application root, the extracted
 * package's own root, and the installed root itself) — the same list
 * `typeRootsFor`/`resolveTypeFile` in the parent module walk. A package like
 * `vite` or `@cloudflare/workers-types` usually lives only under the owning
 * application's own `node_modules` in a strict/isolated pnpm install, never
 * hoisted to the workspace root, so resolving purely from `installedRoot`
 * finds neither its `@types`-style entry point nor its real module file and
 * wrongly keeps the name in `types` (forcing classic typeRoots resolution
 * later, which fails the same way and misreports as TS2688).
 */
export function partitionTypes(
  names: readonly string[],
  installedRoot: string,
  options: ts.CompilerOptions,
  owners: readonly string[] = [""],
): { readonly types: string[]; readonly ambient: string[] } {
  const host = ts.createCompilerHost(options, true);
  const containingFiles = owners.map((owner) => join(installedRoot, owner, `__${TOOL_NAME}_types__.ts`));
  return names.reduce<{ types: string[]; ambient: string[] }>((partition, name) => {
    // A name with a "/" (`vite/client`, `@cloudflare/workers-types`) names a
    // real package or subpath shipping its own declarations, never a
    // DefinitelyTyped-style `@types/<name>` wrapper — it is not reachable
    // through `compilerOptions.typeRoots` at all regardless of hoisting, only
    // through ordinary module resolution. `ts.createProgram`'s own automatic
    // type-directive lookup for `compilerOptions.types` also only consults
    // `typeRoots` (using its own implicit, cwd-derived containing file, not
    // any of `owners`), so classifying such a name as `types` here — even
    // though our own owner-scoped `resolveTypeReferenceDirective` probe
    // below happens to also resolve it — sends it back through a lookup that
    // will not find it there and misreports as TS2688. Resolve it as an
    // ambient root file first and only fall back to `types` if that fails.
    if (name.includes("/")) {
      addAmbientModule(partition, name, containingFiles, options, host);
      return partition;
    }
    const typeReference = containingFiles
      .map((containingFile) => ts.resolveTypeReferenceDirective(name, containingFile, options, host).resolvedTypeReferenceDirective)
      .find((reference) => reference?.resolvedFileName !== undefined);
    if (typeReference?.resolvedFileName) partition.types.push(name);
    else addAmbientModule(partition, name, containingFiles, options, host);
    return partition;
  }, { types: [], ambient: [] });
}

function addAmbientModule(
  partition: { types: string[]; ambient: string[] },
  name: string,
  containingFiles: readonly string[],
  options: ts.CompilerOptions,
  host: ts.CompilerHost,
): void {
  const fallback = containingFiles
    .map((containingFile) => ts.resolveModuleName(name, containingFile, { ...options, types: [] }, host).resolvedModule?.resolvedFileName)
    .find((resolved): resolved is string => resolved !== undefined && resolved.endsWith(".d.ts") && existsSync(resolved));
  if (fallback !== undefined) partition.ambient.push(fallback);
  else partition.types.push(name);
}
