import { describe, expect, test } from "bun:test";
import { cssRuleSurface } from "../src/transaction/css-surface.ts";

describe("CSS emission surface", () => {
  test("walks nested conditional and cascade-layer rules", () => {
    expect(cssRuleSurface('@layer components { @media (width > 1px) { .card { color: red; display: block } } }'))
      .toEqual([{ selector: ".card", properties: ["color", "display"] }]);
  });

  test("preserves escaped and functional selectors while ignoring declaration punctuation", () => {
    expect(cssRuleSurface('.sm\\:block:is(.a,.b), [data-value="a,b"] { --token: "x;y"; color: var(--x, red); }'))
      .toEqual([
        { selector: ".sm\\:block:is(.a,.b)", properties: ["--token", "color"] },
        { selector: '[data-value="a,b"]', properties: ["--token", "color"] },
      ]);
  });

  test("does not promote keyframe or font-face bodies to selectors", () => {
    expect(cssRuleSurface('@font-face { font-family: x; src: url(x) } @keyframes fade { from { opacity: 0 } to { opacity: 1 } }'))
      .toEqual([]);
  });
});
