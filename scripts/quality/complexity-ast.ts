
// ---- line index: byte offset -> 1-based line ----
export function lineIndexer(src: string) {
  const nl: number[] = [0];
  for (let i = 0; i < src.length; i++)
    if (src.charCodeAt(i) === 10) nl.push(i + 1);
  return (off: number) => {
    let lo = 0,
      hi = nl.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (nl[m] <= off) lo = m;
      else hi = m - 1;
    }
    return lo + 1;
  };
}
// FTA cyclomatic: +1 per if/for/while/do/for-in/for-of/catch/ternary, +1 per && ||, +cases per switch
const DECISION = new Set([
  'IfStatement',
  'ForStatement',
  'WhileStatement',
  'DoWhileStatement',
  'ForInStatement',
  'ForOfStatement',
  'CatchClause',
  'ConditionalExpression',
]);
const NEST = new Set([
  'BlockStatement',
  'IfStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
  'SwitchStatement',
  'TryStatement',
]);

type Fn = {
  cyclo: number;
  maxNest: number;
  loc: number;
  name: string;
  cog: number;
};

// ---- cognitive complexity (SonarSource-style) for one function body ----
// Each control-flow structure (if/for/while/do/catch/ternary/switch) adds 1 + nestingDepth.
// A flat switch adds 1 for the switch itself (NOT per case). else / else-if add a flat +1.
// A run of the same binary logical operator adds 1 total. Labeled break/continue adds 1.
// Recursion (self-call by name) adds 1. Nesting increments inside if/loop/switch/catch/function bodies.
export function cognitiveOf(body: any, fnName: string): number {
  let score = 0;
  const self =
    fnName && fnName !== '(anon)' && fnName !== '(computed)' ? fnName : null;

  function selfCallName(callee: any): string | null {
    if (!callee) return null;
    if (callee.type === 'Identifier') return callee.name;
    if (
      callee.type === 'MemberExpression' &&
      callee.object?.type === 'ThisExpression' &&
      callee.property?.type === 'Identifier'
    )
      return callee.property.name;
    return null;
  }

  // parentOp tracks the enclosing logical-operator run so a sequence counts once.
  function walk(n: any, depth: number, parentOp?: string) {
    if (!n || typeof n !== 'object') return;
    switch (n.type) {
      case 'IfStatement': {
        score += 1 + depth;
        walk(n.test, depth);
        walk(n.consequent, depth + 1);
        let alt = n.alternate;
        while (alt) {
          if (alt.type === 'IfStatement') {
            // else-if — flat +1, no nesting bump
            score += 1;
            walk(alt.test, depth);
            walk(alt.consequent, depth + 1);
            alt = alt.alternate;
          } else {
            // else — flat +1
            score += 1;
            walk(alt, depth + 1);
            alt = null;
          }
        }
        return;
      }
      case 'ForStatement':
        score += 1 + depth;
        walk(n.init, depth);
        walk(n.test, depth);
        walk(n.update, depth);
        walk(n.body, depth + 1);
        return;
      case 'ForInStatement':
      case 'ForOfStatement':
        score += 1 + depth;
        walk(n.left, depth);
        walk(n.right, depth);
        walk(n.body, depth + 1);
        return;
      case 'WhileStatement':
        score += 1 + depth;
        walk(n.test, depth);
        walk(n.body, depth + 1);
        return;
      case 'DoWhileStatement':
        score += 1 + depth;
        walk(n.body, depth + 1);
        walk(n.test, depth);
        return;
      case 'CatchClause':
        score += 1 + depth; // only catch increments; try/finally do not
        walk(n.param, depth);
        walk(n.body, depth + 1);
        return;
      case 'SwitchStatement':
        score += 1 + depth; // one increment for the whole switch (flat dispatch)
        walk(n.discriminant, depth);
        for (const c of n.cases ?? []) walk(c, depth + 1);
        return;
      case 'ConditionalExpression':
        score += 1 + depth;
        walk(n.test, depth);
        walk(n.consequent, depth + 1);
        walk(n.alternate, depth + 1);
        return;
      case 'LogicalExpression':
        if (n.operator === '&&' || n.operator === '||') {
          if (n.operator !== parentOp) score += 1; // new run of like operators
          walk(n.left, depth, n.operator);
          walk(n.right, depth, n.operator);
          return;
        }
        break;
      case 'BreakStatement':
      case 'ContinueStatement':
        if (n.label) score += 1; // labeled jump
        return;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        for (const p of n.params ?? []) walk(p, depth);
        walk(n.body, depth + 1); // nested function bodies increment nesting
        return;
      case 'CallExpression':
        if (self && selfCallName(n.callee) === self) score += 1; // recursion
        break;
    }
    // generic descent (fresh logical run) for everything not special-cased above
    for (const k in n) {
      if (k === 'type' || k === 'start' || k === 'end') continue;
      const v = n[k];
      if (Array.isArray(v)) {
        for (const c of v) walk(c, depth);
      } else if (v && typeof v === 'object' && v.type) walk(v, depth);
    }
  }

  walk(body, 0);
  return score;
}
// per-file signals used for archetype classification
type Signals = {
  hasResolverDecorator: boolean;
  superClasses: Set<string>;
  hasJSX: boolean;
  zCalls: number;
  hasEffect: boolean;
  hasStaticCreate: boolean;
  hasPrivateCtor: boolean;
};

function decoratorNames(decorators: any): string[] {
  if (!Array.isArray(decorators)) return [];
  return decorators
    .map((d) => {
      const e = d.expression;
      if (!e) return '';
      if (e.type === 'Identifier') return e.name;
      if (e.type === 'CallExpression' && e.callee?.type === 'Identifier')
        return e.callee.name;
      return '';
    })
    .filter(Boolean);
}

const RESOLVER_DECORATORS = new Set([
  'Resolver',
  'Query',
  'Mutation',
  'ResolveField',
  'Subscription',
]);

export function classifyArchetype(path: string, sig: Signals): string {
  const p = path.toLowerCase();
  const base = path.split('/').pop() ?? '';
  const stem = base.replace(/\.tsx?$/, '');
  const isHandlerName = p.includes('.handler.');
  if (p.includes('.resolver.') || sig.hasResolverDecorator) return 'resolver';
  if (
    sig.superClasses.has('TypedCommandBase') ||
    sig.superClasses.has('BaseCommandHandler') ||
    (p.includes('/commands/') && isHandlerName)
  )
    return 'command-handler';
  if (
    sig.superClasses.has('BaseQueryHandler') ||
    (p.includes('/queries/') && isHandlerName)
  )
    return 'query-handler';
  if (
    p.includes('.entity.') ||
    (p.includes('/models/') && sig.hasStaticCreate && sig.hasPrivateCtor)
  )
    return 'entity';
  if (p.includes('.vo.')) return 'value-object';
  if (
    p.includes('.mapper.') ||
    stem.endsWith('Mapper') ||
    stem.endsWith('mapper')
  )
    return 'mapper';
  if (p.includes('.repository.') || p.includes('prisma-')) return 'repository';
  if (
    /^use[A-Z]/.test(stem) ||
    /\buse[A-Z]/.test(stem) ||
    /^use-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(stem)
  )
    return 'react-hook';
  if (p.endsWith('.tsx') && sig.hasJSX) return 'react-component';
  if (p.includes('.schema.') || p.includes('.schemas.') || sig.zCalls >= 5)
    return 'zod-schema';
  if (sig.hasEffect) return 'effect-service';
  if (p.includes('.dispatcher.')) return 'workflow-dispatcher';
  return 'generic';
}
