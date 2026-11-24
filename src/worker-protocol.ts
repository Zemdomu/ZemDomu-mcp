import type { ResourceBudgets } from "./config.js";
import type { ToolInput, ToolName, ToolResult } from "./contracts.js";

export interface WorkerRequest {
  rootDirectory: string;
  temporaryDirectory: string;
  tool: ToolName;
  input: ToolInput;
  budgets: ResourceBudgets;
  testDelayMs?: number;
}

export interface AnalysisMetrics {
  wallTimeMs: number;
  peakRssBytes: number;
  outputBytes: number;
  estimatedTokens: number;
}

export type WorkerResponse =
  | { ok: true; result: ToolResult; metrics: AnalysisMetrics }
  | { ok: false; code: string; message: string };
