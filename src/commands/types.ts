import type { ParsedArgs } from "../cli/args.ts";

/** Reference-documentation grouping; `docs/cli-reference.md` renders one section per category. */
export type CommandCategory =
  | "Discovery and diagnosis"
  | "Architecture assessment evidence"
  | "Extraction planning"
  | "Extraction execution"
  | "Declaration preparation"
  | "Architectural boundaries"
  | "Configured preparers and ratchets"
  | "Campaigns";

export interface CommandSpec {
  readonly summary: string;
  readonly category: CommandCategory;
  readonly usage: string;
  readonly details?: string;
  readonly run: (args: ParsedArgs) => Promise<void>;
}
