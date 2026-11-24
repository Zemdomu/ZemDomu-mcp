import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { ServerConfiguration } from "./config.js";
import type { ToolInput, ToolName, ToolResult } from "./contracts.js";
import type {
  AnalysisMetrics,
  WorkerRequest,
  WorkerResponse,
} from "./worker-protocol.js";

export class AnalysisRequestError extends Error {
  constructor(
    readonly code: "busy" | "cancelled" | "timeout" | "worker-failed",
    message: string
  ) {
    super(message);
    this.name = "AnalysisRequestError";
  }
}

export interface AnalysisRun {
  result: ToolResult;
  metrics: AnalysisMetrics;
}

export interface RunnerTestControls {
  delayMs?: number;
  onTemporaryDirectory?: (directory: string) => void;
}

export class AnalysisRunner {
  private active = 0;

  constructor(private readonly configuration: ServerConfiguration) {}

  get activeCount(): number {
    return this.active;
  }

  async run(
    tool: ToolName,
    input: ToolInput,
    signal: AbortSignal,
    testControls: RunnerTestControls = {}
  ): Promise<AnalysisRun> {
    if (this.active >= this.configuration.budgets.maxConcurrent) {
      throw new AnalysisRequestError(
        "busy",
        "The local analysis concurrency budget is exhausted."
      );
    }
    if (signal.aborted) {
      throw new AnalysisRequestError("cancelled", "The analysis request was cancelled.");
    }
    this.active += 1;
    try {
      return await this.spawn(tool, input, signal, testControls);
    } finally {
      this.active -= 1;
    }
  }

  private spawn(
    tool: ToolName,
    input: ToolInput,
    signal: AbortSignal,
    testControls: RunnerTestControls
  ): Promise<AnalysisRun> {
    const started = performance.now();
    const temporaryBase = fs.realpathSync(os.tmpdir());
    const temporaryDirectory = fs.mkdtempSync(
      path.join(temporaryBase, "zemdomu-mcp-run-")
    );
    testControls.onTemporaryDirectory?.(temporaryDirectory);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      const resolved = path.resolve(temporaryDirectory);
      const relative = path.relative(temporaryBase, resolved);
      if (
        relative === "" ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        throw new Error("Refusing to remove an unsafe analysis temporary path.");
      }
      fs.rmSync(resolved, { recursive: true, force: true });
    };
    const request: WorkerRequest = {
      rootDirectory: this.configuration.rootDirectory,
      temporaryDirectory,
      tool,
      input,
      budgets: this.configuration.budgets,
      ...(testControls.delayMs === undefined ? {} : { testDelayMs: testControls.delayMs }),
    };
    let worker: Worker;
    try {
      worker = new Worker(new URL("./worker.js", import.meta.url), {
        workerData: request,
        resourceLimits: {
          maxOldGenerationSizeMb: this.configuration.budgets.maxWorkerMemoryMb,
        },
      });
    } catch {
      cleanup();
      throw new AnalysisRequestError(
        "worker-failed",
        "The isolated analysis worker could not be started."
      );
    }

    return new Promise<AnalysisRun>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const stop = (
        code: "cancelled" | "timeout",
        message: string
      ) => {
        finish(() => {
          void worker.terminate().finally(() =>
            {
              cleanup();
              reject(new AnalysisRequestError(code, message));
            }
          );
        });
      };
      const onAbort = () => stop("cancelled", "The analysis request was cancelled.");
      const timeout = setTimeout(
        () => stop("timeout", "The analysis exceeded its wall-clock budget."),
        this.configuration.budgets.timeoutMs
      );
      signal.addEventListener("abort", onAbort, { once: true });

      worker.once("message", (response: WorkerResponse) => {
        finish(() => {
          void worker.terminate().finally(() => {
            cleanup();
            if (response.ok) resolve({
              result: response.result,
              metrics: {
                ...response.metrics,
                wallTimeMs: Number((performance.now() - started).toFixed(3)),
              },
            });
            else reject(new AnalysisRequestError("worker-failed", response.message));
          });
        });
      });
      worker.once("error", () => finish(() => {
        void worker.terminate().finally(() => {
          cleanup();
          reject(new AnalysisRequestError(
            "worker-failed",
            "The isolated analysis worker failed."
          ));
        });
      }));
      worker.once("exit", (code) => {
        if (!settled) {
          finish(() => {
            cleanup();
            reject(new AnalysisRequestError(
              "worker-failed",
              `The isolated analysis worker stopped before returning a result (exit ${code}).`
            ));
          });
        }
      });
    });
  }
}
