import { readFileSync } from "node:fs";
import type { BunPlugin } from "bun";

import { TOOL_NAME } from "../branding.ts";

export const SCANNER_READ_SYMBOL = Symbol.for(`${TOOL_NAME}.scanner-read.v1`);

function linkTypeScript(source: string, path: string): string {
  const load = /const typescript = await tryImport\(\s*"typescript",\s*meta\.supportedTranspilers\.typescript,\s*\);/u;
  const required =
    /\/extract\/(?:tsc\/(?:parse|extract-typescript-deps)|transpile\/typescript-wrap)\.mjs$/u.test(path) || path.endsWith("/config-utl/extract-ts-config.mjs");
  if (required && !load.test(source)) throw new Error(`dependency-cruiser TypeScript integration changed: ${path}`);
  if (load.test(source)) return source.replace(load, 'import typescript from "typescript";');
  if (!path.endsWith("/extract/transpile/meta.mjs")) return source;
  const availability = 'typescript: tryAvailable("typescript", meta.supportedTranspilers.typescript),';
  if (!source.includes(availability)) throw new Error(`dependency-cruiser TypeScript availability changed: ${path}`);
  return source.replace(availability, "typescript: true,");
}

/** Instrument dependency-cruiser's own parser read, not Bun's unsynchronized fs binding. */
export const scannerReadPlugin: BunPlugin = {
  name: `${TOOL_NAME}-scanner-reads`,
  setup(build) {
    build.onLoad({ filter: /dependency-cruiser\/src\/.*\.mjs$/u }, ({ path }) => {
      const source = readFileSync(path, "utf8");
      // Dependency-cruiser's optional dynamic loader cannot find TypeScript's
      // package manifest inside a standalone Bun executable. TypeScript is a
      // required dependency here, so bind it statically in the same onLoad
      // pass as the byte-read hook (a second hook would mask this one).
      const linked = linkTypeScript(source, path);
      if (!linked.includes("readFileSync") || !linked.includes('from "node:fs"')) return { loader: "js", contents: linked };
      const calls = /(?<![.\w])readFileSync\s*\(/gu;
      if (!calls.test(linked)) return { loader: "js", contents: linked };
      const transformed = linked.replaceAll(calls, "__assessmentReadFileSync(");
      const hook = `\nfunction __assessmentReadFileSync(...args) {\n  const result = readFileSync(...args);\n  globalThis[Symbol.for(${JSON.stringify(`${TOOL_NAME}.scanner-read.v1`)})]?.(args[0], result);\n  return result;\n}\n`;
      return { loader: "js", contents: transformed + hook };
    });
  },
};
