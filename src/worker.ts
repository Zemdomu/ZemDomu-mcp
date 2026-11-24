import { parentPort, workerData } from "node:worker_threads";
import { analyzeTool } from "./analyze.js";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol.js";

if (!parentPort) throw new Error("ZemDomu analysis worker requires a parent port.");
const port = parentPort;

const request = workerData as WorkerRequest;
const started = performance.now();
let peakRssBytes = process.memoryUsage().rss;
const sampleMemory = () => {
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
};

void analyzeTool({
  ...request,
  signal: new AbortController().signal,
  sampleMemory,
}).then((result) => {
  sampleMemory();
  const outputBytes = Buffer.byteLength(JSON.stringify(result));
  const response: WorkerResponse = {
    ok: true,
    result,
    metrics: {
      wallTimeMs: Number((performance.now() - started).toFixed(3)),
      peakRssBytes,
      outputBytes,
      estimatedTokens: Math.ceil(outputBytes / 4),
    },
  };
  port.postMessage(response);
}).catch((error: unknown) => {
  const response: WorkerResponse = {
    ok: false,
    code: error instanceof DOMException && error.name === "AbortError"
      ? "cancelled"
      : "analysis-failed",
    message: publicError(error),
  };
  port.postMessage(response);
});

function publicError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Analysis failed.";
  const { rootDirectory, temporaryDirectory } = request;
  return raw
    .split(rootDirectory).join("[workspace]")
    .split(rootDirectory.replace(/\\/g, "/")).join("[workspace]")
    .split(temporaryDirectory).join("[temporary]")
    .split(temporaryDirectory.replace(/\\/g, "/")).join("[temporary]");
}
