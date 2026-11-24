export interface ResourceBudgets {
  maxFiles: number;
  maxTotalBytes: number;
  maxDepth: number;
  timeoutMs: number;
  maxOutputBytes: number;
  maxConcurrent: number;
  maxWorkerMemoryMb: number;
}

export const DEFAULT_RESOURCE_BUDGETS: Readonly<ResourceBudgets> = Object.freeze({
  maxFiles: 250,
  maxTotalBytes: 8 * 1024 * 1024,
  maxDepth: 24,
  timeoutMs: 8_000,
  maxOutputBytes: 256 * 1024,
  maxConcurrent: 1,
  maxWorkerMemoryMb: 256,
});

export interface ServerConfiguration {
  rootDirectory: string;
  budgets: ResourceBudgets;
}

export function withBudgets(
  overrides: Partial<ResourceBudgets> = {}
): ResourceBudgets {
  const budgets = { ...DEFAULT_RESOURCE_BUDGETS, ...overrides };
  for (const [name, value] of Object.entries(budgets)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new TypeError(`${name} must be a positive integer.`);
    }
  }
  return budgets;
}
