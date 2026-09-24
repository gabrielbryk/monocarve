/**
 * The hand-written parts of `docs/cli-reference.md`: what the command registry
 * cannot say about itself.
 *
 * Longer prose lives beside this file as Markdown fragments:
 *   - `notes/commands/<command>.md` is appended to that command's entry;
 *   - `notes/categories/<category-slug>.md` closes that category's section.
 * The generator refuses a fragment that names no registered command or
 * category, so notes cannot silently outlive what they describe.
 */

import type { CommandCategory } from "../../src/commands/index.ts";

/** Section order of the reference. Every category a command uses must be listed. */
export const CATEGORY_ORDER: readonly CommandCategory[] = [
  "Discovery and diagnosis",
  "Architecture assessment evidence",
  "Extraction planning",
  "Extraction execution",
  "Declaration preparation",
  "Architectural boundaries",
  "Configured preparers and ratchets",
  "Campaigns",
];

export const INTRO = `This reference is generated from the executable command registry
(\`src/commands\`). Run \`monocarve <command> --help\` for the same usage and safety
boundary at the terminal. Commands print JSON whenever their result is
structured or \`--json\` is supplied; \`--out\` writes the same deterministic
representation to a file where supported. Configuration keys are documented in
[configuration.md](configuration.md).`;

export const GLOBAL_NOTES = `Global options work before or after the command; command options follow the
command. Campaign commands that require fresh evidence refuse \`--graph\`
replay. \`--version --verbose\` adds the versioned executable/compiler identity and
packaging mode.`;

/** Notes for accepted flags that the usage string does not show. */
export const HIDDEN_FLAG_NOTES: Readonly<Record<string, Readonly<Record<string, string>>>> = { check: { check: "legacy spelling of `check <name>`" } };

export interface ExitCode {
  readonly code: string;
  readonly meaning: string;
}

/**
 * Mirrors the exit-code comment on `main()` in src/cli.ts and the taxonomy in
 * src/errors.ts; 130/143 come from src/transaction/apply-interrupt.ts. The
 * docs test cross-checks the numeric codes against src/cli.ts.
 */
export const EXIT_CODES: readonly ExitCode[] = [
  { code: "0", meaning: "Command completed and its reported proof passed; also bare invocation, `--help`, and `--version`." },
  {
    code: "1",
    meaning:
      "Expected failure or refusal (bad input, config, or repository state), or a command that ran and reported a negative verdict: a failed validation, simulation, check, or audit, or a fatal assessment.",
  },
  { code: "2", meaning: "Degraded assessment: evidence was published, but the workspace only partially qualified (`assess` and batch `split-candidates`)." },
  { code: "3", meaning: "A selected adapter or integration is explicitly not yet ported." },
  { code: "64", meaning: "Invalid command usage: unknown command or flag, missing or invalid value, or no command. The command's usage line is printed." },
  { code: "70", meaning: "Unexpected internal defect; the CLI prints the full cause chain." },
  {
    code: "130 / 143",
    meaning:
      "A committing `apply` interrupted by SIGINT / SIGTERM (128 + the signal number). Mid-journal it first restores the durable checkpoint; either way it releases the lock and reports the outcome. If recovery fails, inspect with `apply-status`.",
  },
];
