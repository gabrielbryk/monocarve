/**
 * Renders `docs/configuration.md` by walking the JSON Schema that zod derives
 * from `monocarveConfigSchema` (input side: what a user writes). Descriptions
 * come from each field's `.describe()` text.
 */

import { z } from "zod";

import { CONFIG_FILENAMES, TOOL_NAME } from "../../src/branding.ts";
import { monocarveConfigSchema, SUPPORTED_PACKAGE_MANAGERS, SUPPORTED_TASK_RUNNERS } from "../../src/config/schema.ts";
import { blocks, code, GENERATED_BANNER, table } from "./markdown.ts";

interface JsonSchema {
  readonly type?: string | readonly string[];
  readonly description?: string;
  readonly default?: unknown;
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly items?: JsonSchema;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: JsonSchema | boolean;
  readonly anyOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
}

/** One documented field. `path` is relative to its top-level key. */
interface ConfigField {
  readonly path: string;
  readonly type: string;
  readonly defaultValue: string;
  /** `yes`, `no`, or `in variant` for a field only some union alternatives require. */
  readonly required: "yes" | "no" | "in variant";
  readonly description: string;
}

/** Defaults computed from the machine running the generator; documented in words instead. */
const MACHINE_LOCAL_DEFAULTS: Readonly<Record<string, string>> = { "transaction.worktreeRoot": "checkout-derived cache directory" };

/** Adapter enums name unported adapters that validation refuses; document only the supported ones. */
const TYPE_OVERRIDES: Readonly<Record<string, string>> = {
  packageManager: SUPPORTED_PACKAGE_MANAGERS.map((value) => JSON.stringify(value)).join(" | "),
  taskRunner: SUPPORTED_TASK_RUNNERS.map((value) => JSON.stringify(value)).join(" | "),
};

/** The smallest valid config: every required key and nothing else. */
export const MINIMAL_CONFIG = {
  applications: [{ name: "web", sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json" }],
  packageRoots: ["libs"],
  scaffoldTemplates: { packageJson: { file: "tools/monocarve/package.json.tpl" } },
} as const;

/** Duck-types the zod-generated payload as our narrower local shape; both describe the same JSON Schema document. */
function isJsonSchemaLike(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null;
}

function configSchema(): JsonSchema {
  const schema: unknown = z.toJSONSchema(monocarveConfigSchema, { io: "input", unrepresentable: "any" });
  if (!isJsonSchemaLike(schema)) throw new Error("invariant: z.toJSONSchema returned a non-object schema");
  return schema;
}

function variants(node: JsonSchema): readonly JsonSchema[] | undefined {
  return node.anyOf ?? node.oneOf;
}

function isRecord(node: JsonSchema): node is JsonSchema & { additionalProperties: JsonSchema } {
  return typeof node.additionalProperties === "object" && node.properties === undefined;
}

function objectShape(node: JsonSchema): string {
  const required = new Set(node.required ?? []);
  const keys = Object.keys(node.properties ?? {}).map((key) => (required.has(key) ? key : `${key}?`));
  return `{ ${keys.join(", ")} }`;
}

function renderType(node: JsonSchema, inUnion = false): string {
  const options = variants(node);
  if (options) return [...new Set(options.map((option) => renderType(option, true)))].join(" | ");
  if (node.const !== undefined) return JSON.stringify(node.const);
  if (node.enum) return node.enum.map((value) => JSON.stringify(value)).join(" | ");
  const type = Array.isArray(node.type) ? node.type.join(" | ") : node.type;
  if (type === "array") {
    const item = node.items ? renderType(node.items) : "unknown";
    return item.includes(" ") && !item.startsWith("{") && !item.startsWith("Record<") ? `(${item})[]` : `${item}[]`;
  }
  if (type === "object") {
    if (isRecord(node)) return `Record<string, ${renderType(node.additionalProperties)}>`;
    return inUnion && node.properties ? objectShape(node) : "object";
  }
  return typeof type === "string" ? type : "unknown";
}

/** JSON with a space after each separator, so defaults read like the config source. */
function compactJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(compactJson).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${compactJson(item)}`);
    return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
  }
  return JSON.stringify(value);
}

function renderDefault(path: string, node: JsonSchema): string {
  if (path in MACHINE_LOCAL_DEFAULTS) return MACHINE_LOCAL_DEFAULTS[path] ?? "";
  return node.default === undefined ? "" : code(compactJson(node.default));
}

/** Distinct descriptions of one field reached through several union alternatives. */
function mergeDescriptions(left: string, right: string): string {
  if (right === "" || left.includes(right)) return left;
  return left === "" ? right : `${left} ${right}`;
}

/** Collect every field below `node`, depth first, alphabetically at each level. */
function collect(node: JsonSchema, prefix: string, fields: Map<string, ConfigField>, alternatives: readonly JsonSchema[] = []): void {
  const options = variants(node);
  if (options) {
    for (const option of options) collect(option, prefix, fields, options);
    return;
  }
  if (node.items) {
    collect(node.items, `${prefix}[]`, fields);
    return;
  }
  if (isRecord(node)) {
    collect(node.additionalProperties, `${prefix}.<key>`, fields);
    return;
  }
  // A key every union alternative requires is simply required; one only some alternatives require is not.
  const requiredEverywhere = (key: string): boolean =>
    alternatives.every((alternative) => alternative.properties === undefined || (alternative.required ?? []).includes(key));
  const required = new Set(node.required ?? []);
  for (const [key, child] of Object.entries(node.properties ?? {}).toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    const field: ConfigField = {
      path,
      type: TYPE_OVERRIDES[path] ?? renderType(child),
      defaultValue: renderDefault(path, child),
      required: !required.has(key) ? "no" : requiredEverywhere(key) ? "yes" : "in variant",
      // A discriminator documents each alternative: prefix its text with the literal it selects.
      description:
        child.const !== undefined && alternatives.length > 1 && child.description
          ? `${code(JSON.stringify(child.const))}: ${child.description}`
          : (child.description ?? ""),
    };
    const existing = fields.get(path);
    // A field reached through several union variants: merge its types.
    if (existing) {
      const types = [...new Set([...existing.type.split(" | "), ...field.type.split(" | ")])].join(" | ");
      fields.set(path, { ...existing, type: types, description: mergeDescriptions(existing.description, field.description) });
    } else fields.set(path, field);
    collect(child, path, fields);
  }
}

/** Every documented field, keyed by full dotted path from the config root. */
export function configFields(): ReadonlyMap<string, ConfigField> {
  const fields = new Map<string, ConfigField>();
  collect(configSchema(), "", fields);
  return fields;
}

function fieldRows(fields: readonly ConfigField[], parent: string): string[][] {
  return fields.map((field) => [
    code(parent === "" ? field.path : field.path.slice(parent.length).replace(/^\./u, "")),
    code(field.type),
    field.defaultValue,
    field.required,
    field.description,
  ]);
}

const HEADERS = ["key", "type", "default", "required", "description"];

function serialize(value: unknown, indent: string): string {
  if (Array.isArray(value)) return `[${value.map((item) => serialize(item, indent)).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const inner = `${indent}  `;
    const entries = Object.entries(value).map(
      ([key, item]) => `${inner}${/^[A-Za-z_$][\w$]*$/u.test(key) ? key : JSON.stringify(key)}: ${serialize(item, inner)},`,
    );
    return `{\n${entries.join("\n")}\n${indent}}`;
  }
  return JSON.stringify(value);
}

/** Adapter names the schema's enum recognizes but validation refuses as not yet supported. */
function unsupportedAdapters(schema: JsonSchema): string[] {
  const supported = new Set([...SUPPORTED_PACKAGE_MANAGERS, ...SUPPORTED_TASK_RUNNERS]);
  return ["packageManager", "taskRunner"]
    .flatMap((key) => schema.properties?.[key]?.enum ?? [])
    .map(String)
    .filter((value) => !supported.has(value));
}

/** Unformatted Markdown for `docs/configuration.md`. */
export function renderConfiguration(): string {
  const unsupported = unsupportedAdapters(configSchema());
  const fields = [...configFields().values()];
  const topLevel = fields.filter((field) => !field.path.includes(".") && !field.path.includes("["));
  const sections = topLevel
    .map((top) => {
      const nested = fields.filter((field) => field.path.startsWith(`${top.path}.`) || field.path.startsWith(`${top.path}[]`));
      if (nested.length === 0) return undefined;
      return blocks(`### ${code(top.path)}`, top.description, table(HEADERS, fieldRows(nested, top.path)));
    })
    .filter((section): section is string => section !== undefined);

  return blocks(
    GENERATED_BANNER,
    "# Configuration reference",
    `Every key ${TOOL_NAME} accepts, generated from the zod schema in \`src/config/schema*.ts\`
(\`monocarveConfigSchema\`). Unknown keys are rejected at every level. Types are
the input shape you write; defaults are applied when a key is omitted. Nested
keys are written relative to their top-level key: \`[]\` is an array element and
\`<key>\` is a record entry.`,
    "## Config files",
    `${TOOL_NAME} discovers its config by walking upward from the working directory
(or \`--cwd\`) and takes the first match, in this precedence order, in the
nearest directory that has one. \`--config <path>\` names a file explicitly.`,
    CONFIG_FILENAMES.map((name) => `- ${code(name)}`).join("\n"),
    `Executable configs (\`.ts\`, \`.mts\`, \`.js\`, \`.mjs\`) default-export the config
object; \`defineConfig\` from \`${TOOL_NAME}/config\` is an identity helper that gives
editors completion and type errors. JSON configs contain the object itself.`,
    "## Minimal example",
    `The required keys are ${topLevel
      .filter((field) => field.required === "yes")
      .map((field) => code(field.path))
      .join(", ")}; everything else has a default.`,
    ["```ts", `import { defineConfig } from "${TOOL_NAME}/config";`, "", `export default defineConfig(${serialize(MINIMAL_CONFIG, "")});`, "```"].join("\n"),
    "## Adapters",
    table(
      ["key", "supported values", "default"],
      [
        [code("packageManager"), TYPE_OVERRIDES.packageManager ?? "", fields.find((field) => field.path === "packageManager")?.defaultValue ?? ""],
        [code("taskRunner"), TYPE_OVERRIDES.taskRunner ?? "", fields.find((field) => field.path === "taskRunner")?.defaultValue ?? ""],
      ].map(([key, values, fallback]) => [key ?? "", (values ?? "").split(" | ").map(code).join(", "), fallback ?? ""]),
    ),
    unsupported.length > 0 ? `Also recognized but refused at load time as not yet supported: ${unsupported.map(code).join(", ")}.` : undefined,
    "## Top-level keys",
    table(HEADERS, fieldRows(topLevel, "")),
    "## Nested keys",
    ...sections,
  );
}
