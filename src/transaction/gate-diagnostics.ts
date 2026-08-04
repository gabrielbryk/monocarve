/** Bounded and durable evidence for a failed repository gate. */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const OUTPUT_LIMIT = 8000;
const OUTPUT_HEAD_SHARE = 0.25;

export interface DiagnosticOutput {
  readonly stdout: string;
  readonly stderr: string;
}

export function completeGateOutput(result: DiagnosticOutput): string {
  return [`--- stdout ---\n${result.stdout}`, `--- stderr ---\n${result.stderr}`].join("\n");
}

export function diagnosticExcerpts(output: string): { readonly head: string; readonly tail: string } {
  if (output.length <= OUTPUT_LIMIT) return { head: output, tail: output };
  const headLength = Math.floor(OUTPUT_LIMIT * OUTPUT_HEAD_SHARE);
  return { head: output.slice(0, headLength), tail: output.slice(-(OUTPUT_LIMIT - headLength)) };
}

export function failedGateOutput(result: DiagnosticOutput): string {
  const streams = [result.stdout, result.stderr].filter((stream) => stream.length > 0);
  if (streams.length === 0) return "";
  const separators = streams.length - 1;
  const limit = Math.floor((OUTPUT_LIMIT - separators) / streams.length);
  return streams.map((stream) => boundedOutput(stream, limit)).join("\n");
}

export function persistDiagnostic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, { encoding: "utf8", flag: "wx" });
}

function boundedOutput(output: string, limit: number): string {
  if (output.length <= limit) return output;
  const marker = "\n… output omitted …\n";
  const available = limit - marker.length;
  const head = Math.floor(available * OUTPUT_HEAD_SHARE);
  const tail = available - head;
  return `${output.slice(0, head)}${marker}${output.slice(-tail)}`;
}
