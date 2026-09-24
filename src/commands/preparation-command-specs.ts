import type { ParsedArgs } from "../cli/args.ts";
import { UsageError } from "../errors.ts";
import type { CommandSpec } from "./types.ts";

interface PreparationHandlers {
  readonly seams: (args: ParsedArgs) => Promise<void>;
  readonly multiFileSeams: (args: ParsedArgs) => Promise<void>;
  readonly preparePlan: (args: ParsedArgs) => Promise<void>;
  readonly prepareMultiPlan: (args: ParsedArgs) => Promise<void>;
  readonly prepareAudit: (args: ParsedArgs) => Promise<void>;
  readonly prepareApply: (args: ParsedArgs) => Promise<void>;
  readonly campaignResolve: (args: ParsedArgs) => Promise<void>;
  readonly campaignOptimize: (args: ParsedArgs) => Promise<void>;
  readonly campaignInit: (args: ParsedArgs) => Promise<void>;
  readonly campaignShowStatus: (args: ParsedArgs) => Promise<void>;
  readonly campaignAdvance: (args: ParsedArgs) => Promise<void>;
  readonly campaignRecord: (args: ParsedArgs) => Promise<void>;
  readonly boundary: CommandSpec;
}

/** Keep CLI metadata separate from preparation orchestration mechanics. */
export function preparationCommandSpecs(handlers: PreparationHandlers): Record<string, CommandSpec> {
  return {
    seams: {
      summary: "compile a read-only declaration-SCC seam proposal",
      category: "Discovery and diagnosis",
      usage: "seams --file <path> --candidate <id> [--target <path>] [--app <name>]",
      details: "Reports moved and retained groups, boundary imports, consumers, cycles, blockers, and type-only preparation eligibility without writing files.",
      run: handlers.seams,
    },
    "seams-multi": {
      summary: "compile read-only declaration SCCs across explicit source files",
      category: "Discovery and diagnosis",
      usage: "seams-multi --file <path> --file <path> [--app <name>]",
      details:
        "Requires at least two configured application files and reports exact cross-file symbol edges, merged declarations, SCCs, and affected consumers.",
      run: handlers.multiFileSeams,
    },
    "prepare-plan": {
      summary: "compile a type-only declaration preparation plan",
      category: "Declaration preparation",
      usage:
        "prepare-plan --file <path> --candidate <id> --target <path> --module-specifier <specifier> --group <id> [--group <id> ...] [--app <name>] [--out <path>] [--write]",
      details:
        "Only explicitly reviewed, safely type-only groups are accepted. Commit the written manifest with its rendered plan subject before prepare-apply --commit.",
      run: handlers.preparePlan,
    },
    "prepare-multi-plan": {
      summary: "compile one atomic multi-file type preparation",
      category: "Declaration preparation",
      usage: "prepare-multi-plan --spec <path> [--app <name>] [--out <path>] [--write]",
      details:
        "The JSON spec names one reviewed multi-file candidate plus per-donor candidate, groups, target, and module specifier. Compilation requires exact atomic coverage and emits one replayable manifest; it never edits source.",
      run: handlers.prepareMultiPlan,
    },
    "prepare-audit": {
      summary: "audit an applied declaration-preparation plan",
      category: "Declaration preparation",
      usage: "prepare-audit --plan <path>",
      details: "Independently rescans baseline graph evidence and replays the exact declaration, import, and public-surface recipe.",
      run: handlers.prepareAudit,
    },
    "prepare-apply": {
      summary: "simulate or apply a reviewed declaration-preparation plan",
      category: "Declaration preparation",
      usage: "prepare-apply --plan <path> [--commit]",
      details:
        "Without --commit, runs replay, audit, and configured preparation gates in isolation. With --commit, requires the approved manifest commit and audits immediately.",
      run: handlers.prepareApply,
    },
    campaign: campaignSpec(handlers),
    boundary: handlers.boundary,
  };
}

function campaignSpec(handlers: PreparationHandlers): CommandSpec {
  return {
    summary: "initialize, inspect, advance, or record a campaign",
    category: "Campaigns",
    usage:
      "campaign optimize --app <name> [--limit <n>] [--out <targets>] [--write]\n       campaign resolve --targets <file> [--out <plan>] [--write]\n       campaign init --campaign <ledger> --id <id> --objective <text> --max-pairs <count> [--write]\n       campaign status --campaign <ledger>\n       campaign advance --campaign <ledger> [--next-plan <manifest> --pair <id>] [--write]\n       campaign record --campaign <ledger> --plan <manifest> --pair <id> [--write]",
    details:
      "Optimize ranks stable extraction targets by LOC per review unit and reports preparation priorities. Resolve rescans current HEAD, skips paths no longer application-owned, resolves one current candidate, and stops for review.",
    run: async (args) => {
      const action = args.positionals[0];
      const nested = { ...args, positionals: args.positionals.slice(1) };
      if (action === "optimize") return handlers.campaignOptimize(nested);
      if (action === "resolve") return handlers.campaignResolve(nested);
      if (action === "init") return handlers.campaignInit(nested);
      if (action === "status") return handlers.campaignShowStatus(nested);
      if (action === "advance") return handlers.campaignAdvance(nested);
      if (action === "record") return handlers.campaignRecord(nested);
      throw new UsageError(`unknown campaign action ${JSON.stringify(action ?? "")}; expected optimize, resolve, init, status, advance, or record`);
    },
  };
}
