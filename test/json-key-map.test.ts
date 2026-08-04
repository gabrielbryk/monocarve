import { describe, expect, test } from "bun:test";

import { relocateJsonObjectKeys } from "../src/path-migrations/json-key-map.ts";

describe("JSON path-key migration filter", () => {
  test("relocates only declared keys under the configured object", () => {
    expect(relocateJsonObjectKeys({
      artifact: "baseline.json",
      contents: '{"files":{"app/a.ts":{"score":1},"keep.ts":{"score":2}},"note":"stable"}\n',
      moves: [{ source: "app/a.ts", target: "libs/a.ts" }],
    }, "/files")).toBe(
      '{\n  "files": {\n    "keep.ts": {\n      "score": 2\n    },\n    "libs/a.ts": {\n      "score": 1\n    }\n  },\n  "note": "stable"\n}\n',
    );
  });

  test("refuses an occupied destination", () => {
    expect(() => relocateJsonObjectKeys({
      artifact: "baseline.json", contents: '{"files":{"a.ts":1,"b.ts":2}}', moves: [{ source: "a.ts", target: "b.ts" }],
    }, "/files")).toThrow("destination key already exists");
  });
});
