import { execSync } from "child_process";
import { readFileSync, statSync } from "fs";
// Homegrown structural complexity analyzer built with Bun and oxc-parser.
// Computes: ftaScore (replicates fta-cli's formula for continuity) + structuralScore
// (actionable-maintainability: cognitive-density, nesting, fan-out, responsibilities, fat methods)
// + per-file cognitive complexity, archetype classification, cohort percentiles + a lever diagnosis.
//
//   PLAT=/repo bun complexity.ts <dir-or-file> [--json]
import { parseSync } from "oxc-parser";

function repoRoot(): string {
  if (process.env.PLAT) return process.env.PLAT;
  try {
    return execSync("git rev-parse --show-toplevel").toString().trim();
  } catch {
    return process.cwd();
  }
}

const asJson = process.argv.includes("--json");
const targets = process.argv.slice(2).filter((a) => a !== "--json");
if (targets.length === 0) targets.push(".");
const PLAT = repoRoot();

import { classifyArchetype, cognitiveOf, DECISION, decoratorNames, type Fn, lineIndexer, NEST, RESOLVER_DECORATORS, type Signals } from "./complexity-ast.ts";
function analyzeFile(path: string, src: string) {
  const lineAt = lineIndexer(src);
  const lineCount = src.split("\n").length;
  const r = parseSync(path, src);
  const prog = r.program;

  // whole-file halstead-ish vocab (for ftaScore) + total cyclo
  const ops = new Set<string>(),
    operands = new Set<string>();
  let fileCyclo = 1;
  // per-function metrics + class structure
  const fns: Fn[] = [];
  const classes: { deps: Set<string>; collaborators: Set<string>; methods: { name: string; fields: Set<string>; isCtor: boolean }[]; ctorParams: number }[] =
    [];
  const sig: Signals = {
    hasResolverDecorator: false,
    superClasses: new Set(),
    hasJSX: false,
    zCalls: 0,
    hasEffect: false,
    hasStaticCreate: false,
    hasPrivateCtor: false,
  };

  function fnMetrics(body: any, nameHint: string): Fn {
    let cyclo = 1,
      maxNest = 0;
    (function walk(n: any, depth: number) {
      if (!n || typeof n !== "object") return;
      const t = n.type;
      if (DECISION.has(t)) cyclo++;
      if (t === "SwitchStatement" && Array.isArray(n.cases)) cyclo += n.cases.length;
      if (t === "LogicalExpression" && (n.operator === "&&" || n.operator === "||")) cyclo++;
      const nd = NEST.has(t) ? depth + 1 : depth;
      if (nd > maxNest) maxNest = nd;
      for (const k in n) {
        if (k === "type" || k === "start" || k === "end") continue;
        const v = (n as any)[k];
        if (Array.isArray(v)) for (const c of v) walk(c, nd);
        else if (v && typeof v === "object" && v.type) walk(v, nd);
      }
    })(body, 0);
    const loc = body?.start != null && body?.end != null ? lineAt(body.end) - lineAt(body.start) + 1 : 0;
    return { cyclo, maxNest, loc, name: nameHint, cog: cognitiveOf(body, nameHint) };
  }

  // collect this.<field> accessed (for cohesion clustering) + this.<field> CALLED as a
  // collaborator (this.field.method(...) or this.field(...) where field is a dep, not an own method).
  function thisFields(node: any, out: Set<string>, collaborators?: Set<string>) {
    (function w(n: any) {
      if (!n || typeof n !== "object") return;
      if (n.type === "MemberExpression" && n.object?.type === "ThisExpression" && n.property?.type === "Identifier") out.add(n.property.name);
      // collaborator: this.field.<anything>(...)  → field is an injected dep we call methods on
      if (collaborators && n.type === "CallExpression" && n.callee?.type === "MemberExpression") {
        const obj = n.callee.object;
        if (obj?.type === "MemberExpression" && obj.object?.type === "ThisExpression" && obj.property?.type === "Identifier") {
          collaborators.add(obj.property.name);
        }
      }
      for (const k in n) {
        if (k === "type" || k === "start" || k === "end") continue;
        const v = n[k];
        if (Array.isArray(v)) v.forEach(w);
        else if (v && typeof v === "object" && v.type) w(v);
      }
    })(node);
  }

  (function top(n: any) {
    if (!n || typeof n !== "object") return;
    const t = n.type;
    // file-level halstead vocab
    if (t === "LogicalExpression" || t === "BinaryExpression" || t === "AssignmentExpression" || t === "UnaryExpression") {
      ops.add(n.operator);
    }
    if (t === "Identifier") operands.add(n.name);
    if (t === "StringLiteral" || t === "NumericLiteral" || t === "BooleanLiteral") operands.add(String(n.value));
    if (DECISION.has(t)) fileCyclo++;
    if (t === "SwitchStatement" && Array.isArray(n.cases)) fileCyclo += n.cases.length;
    if (t === "LogicalExpression" && (n.operator === "&&" || n.operator === "||")) fileCyclo++;

    // ---- archetype signals ----
    if (t === "JSXElement" || t === "JSXFragment") sig.hasJSX = true;
    if (t === "MemberExpression" && n.object?.type === "Identifier") {
      const o = n.object.name,
        prop = n.property?.name;
      if (o === "z") sig.zCalls++;
      if (o === "Effect" && (prop === "gen" || prop === "Service")) sig.hasEffect = true;
      if (o === "Context" && prop === "Tag") sig.hasEffect = true;
    }
    if (Array.isArray(n.decorators)) for (const d of decoratorNames(n.decorators)) if (RESOLVER_DECORATORS.has(d)) sig.hasResolverDecorator = true;

    if (t === "FunctionDeclaration" || t === "FunctionExpression" || t === "ArrowFunctionExpression") {
      if (n.body) fns.push(fnMetrics(n.body, n.id?.name ?? "(anon)"));
    }
    if (t === "ClassDeclaration" || t === "ClassExpression") {
      if (n.superClass?.type === "Identifier") sig.superClasses.add(n.superClass.name);
      const cls = { deps: new Set<string>(), collaborators: new Set<string>(), methods: [] as any[], ctorParams: 0 };
      for (const m of n.body?.body ?? []) {
        if (m.type === "MethodDefinition" || m.type === "PropertyDefinition") {
          const name = m.key?.name ?? m.key?.value ?? "(computed)";
          const isCtor = m.kind === "constructor";
          if (isCtor) {
            cls.ctorParams = m.value?.params?.length ?? 0;
            if (m.accessibility === "private") sig.hasPrivateCtor = true;
          }
          if (m.static && name === "create") sig.hasStaticCreate = true;
          const fields = new Set<string>();
          if (m.value) thisFields(m.value, fields, cls.collaborators);
          for (const f of fields) cls.deps.add(f);
          if (m.type === "MethodDefinition" && m.value?.body) {
            const fn = fnMetrics(m.value.body, name);
            fns.push(fn);
            cls.methods.push({ name, fields, isCtor });
          }
        }
      }
      classes.push(cls);
    }
    for (const k in n) {
      if (k === "type" || k === "start" || k === "end") continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(top);
      else if (v && typeof v === "object" && v.type) top(v);
    }
  })(prog);

  // ---- ftaScore (replicate fta-cli exactly) ----
  const vocab = ops.size + operands.size;
  const factor = Math.log(fileCyclo) < 1 ? 1 : lineCount / Math.log(fileCyclo);
  const abs = 171 - 5.2 * Math.log(vocab || 1) - 0.23 * fileCyclo - 16.2 * Math.log(factor);
  let ftaScore = 100 - (abs * 100) / 171;
  if (ftaScore < 0) ftaScore = 0;

  // ---- structuralScore (actionable maintainability) ----
  // responsibility count = cohesion clusters of methods by shared specialized this.<dep>
  const cls = classes.sort((a, b) => b.methods.length - a.methods.length)[0];
  let fanOut = 0,
    responsibilities = 0,
    ctorParams = 0;
  const methodCount = fns.length;
  if (cls) {
    fanOut = cls.collaborators.size; // injected deps we call, NOT data fields
    ctorParams = cls.ctorParams;
    // ubiquity filter (>40% of methods) then union-find on shared specialized deps
    const freq = new Map<string, number>();
    const methodNames = new Set(cls.methods.map((m) => m.name));
    cls.methods.forEach((m) =>
      m.fields.forEach((f) => {
        if (!methodNames.has(f)) freq.set(f, (freq.get(f) ?? 0) + 1);
      }),
    );
    const ubiq = new Set([...freq].filter(([, c]) => c >= Math.max(3, Math.ceil(cls.methods.length * 0.4))).map(([f]) => f));
    const spec = cls.methods.map((m) => new Set([...m.fields].filter((f) => !methodNames.has(f) && !ubiq.has(f))));
    const idx = cls.methods.map((_, i) => i).filter((i) => spec[i].size > 0);
    const parent = new Map<number, number>();
    idx.forEach((i) => parent.set(i, i));
    const find = (x: number): number => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x)!)), parent.get(x)!));
    for (let a = 0; a < idx.length; a++)
      for (let b = a + 1; b < idx.length; b++) {
        const i = idx[a],
          j = idx[b];
        if ([...spec[i]].some((d) => spec[j].has(d))) parent.set(find(i), find(j));
      }
    responsibilities = new Set(idx.map((i) => find(i))).size;
  }
  const cyclos = fns.map((f) => f.cyclo);
  const cogs = fns.map((f) => f.cog);
  const avgCyclo = cyclos.length ? cyclos.reduce((a, b) => a + b, 0) / cyclos.length : 0;
  const maxCyclo = Math.max(0, ...cyclos);
  const cognitive = cogs.reduce((a, b) => a + b, 0);
  const maxCognitive = Math.max(0, ...cogs);
  const avgCognitive = cogs.length ? cognitive / cogs.length : 0;
  const maxNest = Math.max(0, ...fns.map((f) => f.maxNest));
  const maxMethodLoc = Math.max(0, ...fns.map((f) => f.loc));

  // weights (tuned against labeled cases). Branching term is now COGNITIVE, not cyclomatic:
  // cognitive rewards flattening nested logic and does NOT over-penalize flat switch/dispatch tables.
  const structuralScore =
    2.0 * maxCognitive +
    4.0 * avgCognitive +
    4.0 * maxNest +
    2.5 * fanOut +
    9.0 * Math.max(0, responsibilities - 1) + // 1 responsibility = cohesive, no penalty
    0.1 * maxMethodLoc;

  const archetype = classifyArchetype(path, sig);

  return {
    path,
    ftaScore: +ftaScore.toFixed(1),
    structuralScore: +structuralScore.toFixed(1),
    cyclo: fileCyclo,
    lineCount,
    vocab,
    methodCount,
    fanOut,
    responsibilities,
    maxNest,
    maxCyclo,
    avgCyclo: +avgCyclo.toFixed(1),
    maxMethodLoc,
    cognitive,
    maxCognitive,
    avgCognitive: +avgCognitive.toFixed(1),
    ctorParams,
    archetype,
    percentiles: {} as Record<string, number>,
    lever: "none",
    leverReason: "",
  };
}

type Result = ReturnType<typeof analyzeFile>;

// ---- gather files (one or more dir/file targets) ----
const EXCLUDE =
  "node_modules|/dist/|\\.spec\\.|\\.test\\.|/generated/|/seeding/|/scenarios?/|/migrations?/|/__tests__/|/testing/|/test-utils?/|\\.stories\\.|\\.template\\.|\\.d\\.ts$|\\.mock\\.|/scripts/|/mocks?/|seed-from-prod|codemod|/it-infra/|\\.config\\.ts$";
const files: string[] = [];
for (const target of targets) {
  const abs = target.startsWith("/") ? target : `${PLAT}/${target}`;
  if (statSync(abs).isFile()) files.push(abs);
  else
    files.push(
      ...execSync(`find "${abs}" -name '*.ts' -o -name '*.tsx' 2>/dev/null | grep -vE '${EXCLUDE}'`, { maxBuffer: 1 << 28 })
        .toString()
        .trim()
        .split("\n")
        .filter(Boolean),
    );
}

const results: Result[] = [];
for (const f of files) {
  try {
    results.push(analyzeFile(f, readFileSync(f, "utf8")));
  } catch (error) {
    // A swallowed per-file error made the tool print an empty table with no
    // diagnostic, which reads as "nothing to report" rather than "nothing was
    // analysed". Report and keep going.
    console.error(`complexity: skipped ${f}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---- second pass: cohort percentiles + lever diagnosis ----
const PCT_METRICS = ["structuralScore", "maxCognitive", "maxNest", "fanOut", "responsibilities", "maxMethodLoc"] as const;
type PctMetric = (typeof PCT_METRICS)[number];
const MIN_COHORT = 8;

function pctRank(sortedAsc: number[], v: number): number {
  const n = sortedAsc.length;
  if (n <= 1) return 50;
  let below = 0,
    equal = 0;
  for (const x of sortedAsc) {
    if (x < v) below++;
    else if (x === v) equal++;
  }
  return Math.round(((below + 0.5 * equal) / n) * 100);
}

// repo-wide sorted values per metric
const repoVals: Record<PctMetric, number[]> = {} as any;
for (const m of PCT_METRICS) repoVals[m] = results.map((r) => r[m] as number).sort((a, b) => a - b);

// group by archetype + precompute cohort sorted values
const byArch = new Map<string, Result[]>();
for (const r of results) {
  const g = byArch.get(r.archetype) ?? [];
  g.push(r);
  byArch.set(r.archetype, g);
}
const cohortVals = new Map<string, Record<PctMetric, number[]>>();
for (const [arch, list] of byArch) {
  const rec: Record<PctMetric, number[]> = {} as any;
  for (const m of PCT_METRICS) rec[m] = list.map((r) => r[m] as number).sort((a, b) => a - b);
  cohortVals.set(arch, rec);
}

function diagnoseLever(r: Result): { lever: string; leverReason: string } {
  const p = r.percentiles;
  // actionable drivers, ranked by cohort percentile
  const drivers = [
    { name: "responsibilities", pct: p.responsibilities },
    { name: "maxCognitive", pct: p.maxCognitive },
    { name: "maxNest", pct: p.maxNest },
    { name: "fanOut", pct: p.fanOut },
  ].sort((a, b) => b.pct - a.pct);
  const top = drivers[0];

  if (r.responsibilities >= 2 && p.responsibilities > 60)
    return { lever: "split-service", leverReason: `${r.responsibilities} responsibility clusters (p${p.responsibilities})` };
  if (top.name === "maxCognitive" && p.maxCognitive > 75)
    return { lever: "extract-method", leverReason: `worst method cognitive ${r.maxCognitive} (p${p.maxCognitive})` };
  if (top.name === "maxNest" && p.maxNest > 60) return { lever: "flatten-nesting", leverReason: `nesting depth ${r.maxNest} (p${p.maxNest})` };
  if (top.name === "fanOut" && p.fanOut > 60) return { lever: "reduce-coupling", leverReason: `fans out to ${r.fanOut} collaborators (p${p.fanOut})` };
  if (r.ctorParams > 5) return { lever: "deps-bag", leverReason: `constructor takes ${r.ctorParams} params` };
  if (r.archetype === "react-component" && p.structuralScore > 60)
    return { lever: "decompose-component", leverReason: `heavy component (struct p${p.structuralScore})` };
  if (r.archetype === "react-hook" && p.structuralScore > 60) return { lever: "extract-hook", leverReason: `heavy hook (struct p${p.structuralScore})` };
  if (top.pct <= 60) return { lever: "none", leverReason: "no term above p60" };
  return { lever: "none", leverReason: `${top.name} at p${top.pct}, below action threshold` };
}

for (const r of results) {
  const cohort = byArch.get(r.archetype)!;
  const useCohort = cohort.length >= MIN_COHORT;
  const src = useCohort ? cohortVals.get(r.archetype)! : repoVals;
  for (const m of PCT_METRICS) r.percentiles[m] = pctRank(src[m], r[m] as number);
  const { lever, leverReason } = diagnoseLever(r);
  r.lever = lever;
  r.leverReason = leverReason;
}

if (asJson) {
  console.log(JSON.stringify(results));
} else {
  results.sort((a, b) => b.structuralScore - a.structuralScore);
  const h = `${"struct".padStart(7)}${"fta".padStart(6)}${"cyc".padStart(5)}${"cog".padStart(5)}${"nest".padStart(5)}${"fan".padStart(4)}${"resp".padStart(5)}  ${"archetype".padEnd(15)}${"lever".padEnd(20)}file`;
  console.log(h);
  for (const r of results.slice(0, 40)) {
    console.log(
      `${String(r.structuralScore).padStart(7)}${String(r.ftaScore).padStart(6)}${String(r.maxCyclo).padStart(5)}${String(r.maxCognitive).padStart(5)}${String(r.maxNest).padStart(5)}${String(r.fanOut).padStart(4)}${String(r.responsibilities).padStart(5)}  ${r.archetype.padEnd(15)}${r.lever.padEnd(20)}${r.path.replace(PLAT + "/", "")}`,
    );
  }
}
