/** Renders `docs/cli-reference.md` from the command registry plus `cli-notes.ts`. */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { TOOL_NAME } from "../../src/branding.ts";
import type { FlagSpec } from "../../src/cli/flags.ts";
import { COMMANDS, GLOBAL_OPTIONS, type CommandCategory, type RegisteredCommand } from "../../src/commands/index.ts";
import { CATEGORY_ORDER, EXIT_CODES, GLOBAL_NOTES, HIDDEN_FLAG_NOTES, INTRO } from "./cli-notes.ts";
import { blocks, code, GENERATED_BANNER, sentence, table } from "./markdown.ts";

const NOTES_DIR = resolve(import.meta.dir, "notes");

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function fragments(kind: "commands" | "categories", known: ReadonlySet<string>): ReadonlyMap<string, string> {
  const dir = resolve(NOTES_DIR, kind);
  const found = new Map<string, string>();
  if (!existsSync(dir)) return found;
  for (const file of readdirSync(dir).toSorted()) {
    if (!file.endsWith(".md")) continue;
    const name = basename(file, ".md");
    if (!known.has(name)) throw new Error(`scripts/docs/notes/${kind}/${file} names no registered ${kind === "commands" ? "command" : "category"}`);
    found.set(name, readFileSync(resolve(dir, file), "utf8"));
  }
  return found;
}

/** `--config <path>       config file (...)` lines of `GLOBAL_OPTIONS`. */
function globalOptionRows(): string[][] {
  return GLOBAL_OPTIONS.split("\n")
    .slice(1)
    .map((line) => {
      const match = /^\s+(\S.*?)\s{2,}(\S.*)$/u.exec(line);
      if (!match) throw new Error(`unparseable GLOBAL_OPTIONS line: ${JSON.stringify(line)}`);
      const option = (match[1] ?? "")
        .split(/,\s*/u)
        .map((part) => code(part))
        .join(", ");
      return [option, sentence(match[2] ?? "")];
    });
}

/** Usage lines as full invocations: continuation lines get the tool name back. */
function usageBlock(usage: string): string {
  const lines = usage.split("\n").map((line, index) => (index === 0 ? line : `${TOOL_NAME} ${line.trim()}`));
  return ["```text", ...lines, "```"].join("\n");
}

/** The placeholder a usage string shows for a flag, e.g. `<path>` for `--out`. */
function placeholder(usage: string, name: string): string | undefined {
  // Flag names are `[a-z0-9-]`, so they need no escaping in a pattern.
  const match = new RegExp(`--${name}[ =](<[^>]*>(?:\\[[^\\]]*\\])?|[a-z][\\w=.-]*)`, "u").exec(usage);
  return match?.[1];
}

function flagForm(flag: FlagSpec): string {
  if (flag.kind === "boolean") return "switch";
  if (flag.kind === "repeatable") return "value, repeatable";
  return "value";
}

function flagSection(name: string, spec: RegisteredCommand): string {
  const shown = new Set([...spec.usage.matchAll(/--([a-z][a-z0-9-]*)/gu)].map((match) => match[1]));
  const accepted = spec.flags.filter((flag) => flag.kind !== "refused");
  const refused = spec.flags.filter((flag) => flag.kind === "refused").map((flag) => code(`--${flag.name}`));
  const rows = accepted.map((flag) => {
    const shape = placeholder(spec.usage, flag.name) ?? (flag.kind === "boolean" ? undefined : "<value>");
    const form = flagForm(flag);
    const hidden = shown.has(flag.name) ? undefined : (HIDDEN_FLAG_NOTES[name]?.[flag.name] ?? "not shown in usage");
    return [code(shape ? `--${flag.name} ${shape}` : `--${flag.name}`), hidden ? `${form}; ${hidden}` : form];
  });
  const flagTable = rows.length > 0 ? table(["flag", "form"], rows) : "Takes no command options.";
  const refusedLine = refused.length > 0 ? `Refused with an explanation rather than as unknown: ${refused.join(", ")}.` : undefined;
  return blocks(flagTable, refusedLine);
}

function commandSection(name: string, spec: RegisteredCommand, note: string | undefined): string {
  return blocks(`### ${code(name)}`, sentence(spec.summary), usageBlock(spec.usage), spec.details, flagSection(name, spec), note);
}

function categorySection(
  category: CommandCategory,
  names: readonly string[],
  notes: { commands: ReadonlyMap<string, string>; categories: ReadonlyMap<string, string> },
): string {
  const overview = table(
    ["command", "summary"],
    names.map((name) => [code(name), sentence(COMMANDS[name]?.summary ?? "")]),
  );
  return blocks(
    `## ${category}`,
    overview,
    ...names.map((name) => {
      const spec = COMMANDS[name];
      if (!spec) throw new Error(`unregistered command ${name}`);
      return commandSection(name, spec, notes.commands.get(name));
    }),
    notes.categories.get(slug(category)),
  );
}

/** Group registry entries by category, in `CATEGORY_ORDER`, keeping registry order within a category. */
function commandsByCategory(): Map<CommandCategory, string[]> {
  const grouped = new Map<CommandCategory, string[]>(CATEGORY_ORDER.map((category) => [category, []]));
  for (const [name, spec] of Object.entries(COMMANDS)) {
    const bucket = grouped.get(spec.category);
    if (!bucket) throw new Error(`command ${name} uses category ${JSON.stringify(spec.category)}, which CATEGORY_ORDER does not list`);
    bucket.push(name);
  }
  for (const [category, names] of grouped) if (names.length === 0) throw new Error(`category ${JSON.stringify(category)} has no commands`);
  return grouped;
}

/** Unformatted Markdown for `docs/cli-reference.md`. */
export function renderCliReference(): string {
  const grouped = commandsByCategory();
  const notes = { commands: fragments("commands", new Set(Object.keys(COMMANDS))), categories: fragments("categories", new Set(CATEGORY_ORDER.map(slug))) };
  return blocks(
    GENERATED_BANNER,
    "# CLI reference",
    INTRO,
    "## Global options",
    table(["option", "meaning"], globalOptionRows()),
    GLOBAL_NOTES,
    ...[...grouped].map(([category, names]) => categorySection(category, names, notes)),
    "## Exit codes",
    table(
      ["code", "meaning"],
      EXIT_CODES.map((entry) => [code(entry.code), entry.meaning]),
    ),
  );
}
