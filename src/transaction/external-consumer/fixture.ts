import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ExtractionManifest } from "../../plan/manifest.ts";

export function writeExternalConsumerFixture(root: string, target: ExtractionManifest["target"]): string {
  const lines = [
    ...importAssertions(target.packageName, target.requiredExports, "Root"),
    ...(target.publicModules ?? []).flatMap((module, index) =>
      importAssertions(module.specifier, module.requiredExports, `Subpath${index}_`),
    ),
  ];
  if (lines.length === 0) lines.push(`import ${JSON.stringify(target.packageName)};`);
  const fixture = join(root, "consumer.ts");
  writeFileSync(fixture, `${lines.join("\n")}\n`);
  return fixture;
}

function importAssertions(
  specifier: string,
  exports: readonly { readonly name: string; readonly typeOnly: boolean }[],
  prefix: string,
): string[] {
  return exports.flatMap((entry, index) => importAssertion(specifier, entry, `${prefix}${index}`));
}

function importAssertion(
  specifier: string,
  entry: { readonly name: string; readonly typeOnly: boolean },
  suffix: string,
): string[] {
  const alias = `__externalConsumerExport${suffix}`;
  const packageName = JSON.stringify(specifier);
  if (entry.name === "default") return defaultAssertion(packageName, alias, entry.typeOnly, suffix);
  const statement = `{ ${JSON.stringify(entry.name)} as ${alias} }`;
  return entry.typeOnly
    ? [`import type ${statement} from ${packageName};`, `type __externalConsumerTypeUse${suffix} = ${alias};`]
    : [`import ${statement} from ${packageName};`, `void ${alias};`];
}

function defaultAssertion(packageName: string, alias: string, typeOnly: boolean, suffix: string): string[] {
  return typeOnly
    ? [`import type ${alias} from ${packageName};`, `type __externalConsumerTypeUse${suffix} = ${alias};`]
    : [`import ${alias} from ${packageName};`, `void ${alias};`];
}
