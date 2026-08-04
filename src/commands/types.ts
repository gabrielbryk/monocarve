import type { ParsedArgs } from "../cli/args.ts";

export interface CommandSpec {
  readonly summary: string;
  readonly usage: string;
  readonly details?: string;
  readonly run: (args: ParsedArgs) => Promise<void>;
}
