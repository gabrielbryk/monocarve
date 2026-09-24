import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { publishEvidence } from "../../src/assessment/evidence.ts";

const [rootDir, requestedPhase] = process.argv.slice(2);
if (rootDir === undefined || requestedPhase === undefined) throw new Error("expected root and publication phase");

publishEvidence({
  rootDir,
  destination: "evidence",
  analyticalRoots: ["src"],
  artifacts: { "raw/app.json": "new raw\n", "summary.json": "new summary\n" },
  requiredArtifacts: new Set(["raw/app.json", "summary.json"]),
  manifest: () => ({ kind: "architecture-assessment" as const }),
  replaceGenerated: true,
  testPhaseHook: (phase) => {
    if (phase !== requestedPhase) return;
    writeFileSync(join(rootDir, ".publisher-ready"), `${phase}\n`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  },
});
