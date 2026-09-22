import { defineConfig } from "oxlint";

/**
 * Standalone equivalent of Keel's `@keel/eslint` `base` preset
 * (keel-base/libs/eslint/src/oxlint-configs.ts), minus what does not port:
 *
 *  - the `keel/*` custom plugin rules (workspace-internal, Keel-only);
 *  - the vitest plugin/rules (monocarve uses `bun:test`, not vitest);
 *  - the npm dependency fences (`no-restricted-imports` for drizzle-orm /
 *    the model SDK) — those encode Keel's own layering, not monocarve's;
 *  - the `frontend`/`backend` preset variants — monocarve is a CLI with no
 *    React surface.
 *
 * Everything else — category policy, env, and the built-in rule triage
 * (§9-style: a rule ends at `error` with zero violations, or it stays off)
 * — is reproduced as-is from Keel's `base`.
 */
export default defineConfig({
  plugins: ["typescript", "unicorn", "oxc", "import", "promise", "node"],
  categories: {
    correctness: "error",
    suspicious: "error",
    perf: "error",
    pedantic: "off",
    style: "off",
    restriction: "off",
    nursery: "off",
  },
  env: { builtin: true, es2024: true },
  ignorePatterns: [
    "**/dist/**",
    "**/artifacts/**",
    "**/node_modules/**",
    "**/coverage/**",
    ".worktrees/**",
    ".monocarve/**",
    "tmp/**",
    // Test fixtures: full monorepo trees (including golden `generated/`
    // output) that tests assert on byte-for-byte. Never lint or reformat.
    "fixtures/**",
    // Raw browser-side scripts served as text assets to the visualization
    // UI (see src/visualization/server.ts's `with { type: "text" }`
    // imports). They are deliberately excluded from tsconfig's `include`
    // (no `.ts`, no module graph) and run against an ambient
    // `globalThis.vis` with no type declarations, so `--type-aware`
    // treats every access as `any` — hundreds of findings that are a
    // property of the file's untyped nature, not real bugs.
    "src/visualization/client.js",
    "src/visualization/layout.js",
  ],
  rules: {
    "unicorn/no-array-sort": "error",
    "unicorn/prefer-set-has": "error",
    "no-await-in-loop": "error",

    // Type-aware; only actually evaluated under `--type-aware` (see the
    // `lint` script). Catch unhandled promises and prevent inferred `any`
    // from spreading.
    "typescript/no-floating-promises": "error",
    "typescript/no-misused-promises": "error",
    "typescript/await-thenable": "error",
    "typescript/no-unsafe-assignment": "error",
    "typescript/no-unsafe-call": "error",
    "typescript/no-unsafe-return": "error",

    // Explicit safety policy, independent of category defaults.
    "typescript/no-unsafe-argument": "error",
    "typescript/no-unsafe-member-access": "error",
    "typescript/switch-exhaustiveness-check": [
      "error",
      { considerDefaultExhaustiveForUnions: false },
    ],
    "typescript/return-await": ["error", "error-handling-correctness-only"],
    "typescript/unbound-method": "error",
    "typescript/no-unsafe-type-assertion": "error",
    "typescript/use-unknown-in-catch-callback-variable": "error",
    "array-callback-return": "error",
    "typescript/no-non-null-assertion": "error",
    "typescript/restrict-plus-operands": [
      "error",
      {
        allowAny: false,
        allowBoolean: false,
        allowNullish: false,
        allowNumberAndString: false,
        allowRegExp: false,
      },
    ],
    eqeqeq: ["error", "always", { null: "ignore" }],
    "import/no-cycle": "error",
    "typescript/only-throw-error": [
      "error",
      { allowThrowingAny: false, allowThrowingUnknown: false, allowRethrowing: true },
    ],
    "typescript/prefer-promise-reject-errors": "error",
    "no-var": "error",
    "prefer-const": "error",
    "no-case-declarations": "error",
    "no-loop-func": "error",
    "no-promise-executor-return": "error",
    "no-prototype-builtins": "error",
    "no-template-curly-in-string": "error",
    "typescript/no-unsafe-function-type": "error",
    "typescript/no-empty-object-type": "error",
    "typescript/no-deprecated": "error",
    "no-fallthrough": "error",
    "typescript/prefer-nullish-coalescing": "error",
    "typescript/no-unnecessary-condition": "error",
    "typescript/no-explicit-any": "error",
    "typescript/consistent-type-imports": "error",

    // OFF — both existing findings (src/prepare/manifest.ts,
    // src/prepare/manifest-recipe.ts) intentionally match control
    // characters (`\u0000`, `\r`, `\n`) to reject untrusted module
    // specifiers containing them. The rule can't distinguish that from an
    // accidental unescaped control character; this validation is the
    // reason the rule would fire, not a bug.
    "no-control-regex": "off",
  },
  overrides: [
    {
      files: ["**/*.test.ts"],
      rules: {
        // OFF — the two findings (test/visualization-server.test.ts)
        // construct `new Function(source)` purely to assert the served
        // client/layout bundle text parses as valid JS syntax. It is
        // never called, and the input is this repo's own build output,
        // not untrusted/user-supplied text — the rule's "implied eval"
        // risk does not apply to a syntax-validity check.
        "typescript/no-implied-eval": "off",
      },
    },
  ],
});
