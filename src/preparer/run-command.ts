import { failedGateOutput } from "../transaction/gate-diagnostics.ts";
import { scrubbedGitEnv } from "../util/git.ts";
import { PreparerError } from "./error.ts";

export async function runPreparerCommand(command: string, cwd: string, timeout: number, label: string): Promise<void> {
  const child = Bun.spawn(["sh", "-c", command], {
    cwd,
    env: scrubbedGitEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeoutTimer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
  const stdoutCapture = captureProcessStream(child.stdout);
  const stderrCapture = captureProcessStream(child.stderr);
  const keepAlive = setInterval(() => undefined, 1_000);
  let exitCode: number;
  let stdout: string;
  let stderr: string;
  try {
    exitCode = await child.exited;
    clearTimeout(timeoutTimer);
    await drainAfterExit([stdoutCapture, stderrCapture], 250);
    [stdout, stderr] = await Promise.all([stdoutCapture.result, stderrCapture.result]);
  } finally {
    clearTimeout(timeoutTimer);
    clearInterval(keepAlive);
  }
  if (exitCode !== 0 || timedOut) {
    const output = failedGateOutput({ stdout, stderr }).trim();
    const reason = timedOut ? `timed out after ${timeout}ms` : `failed (exit ${exitCode})`;
    throw new PreparerError(`${label} command ${reason}${output ? `:\n${output}` : ""}`);
  }
}

interface ProcessStreamCapture {
  readonly result: Promise<string>;
  cancel(): Promise<void>;
}

function captureProcessStream(stream: ReadableStream<Uint8Array>): ProcessStreamCapture {
  const limit = 16_000;
  const marker = "\n… process output omitted …\n";
  const head = 4_000;
  const tail = limit - head - marker.length;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const result = (async (): Promise<string> => {
    let output = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
      if (output.length > limit) output = `${output.slice(0, head)}${marker}${output.slice(-tail)}`;
    }
    output += decoder.decode();
    return output.length <= limit ? output : `${output.slice(0, head)}${marker}${output.slice(-tail)}`;
  })();
  return { result, cancel: async () => { await reader.cancel(); } };
}

async function drainAfterExit(captures: readonly ProcessStreamCapture[], graceMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(captures.map((capture) => capture.result)).then(() => undefined),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, graceMs); }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  await Promise.all(captures.map((capture) => capture.cancel()));
}
