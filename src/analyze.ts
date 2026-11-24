import path from "node:path";
import core from "zemdomu";
import type * as CoreTypes from "zemdomu";
import type { ResourceBudgets } from "./config.js";
import {
  ADAPTER_SCHEMA_VERSION,
  issuesInputSchema,
  pageInputSchema,
  pageSemanticsOutputSchema,
  semanticIssuesOutputSchema,
  type IssuesInput,
  type PageInput,
  type PageSemanticsResult,
  type SemanticIssuesResult,
  type ToolName,
  type ToolResult,
} from "./contracts.js";
import { createWorkspaceSnapshot, type WorkspaceSnapshot } from "./snapshot.js";

interface AnalysisOptions {
  rootDirectory: string;
  temporaryDirectory: string;
  tool: ToolName;
  input: unknown;
  budgets: ResourceBudgets;
  signal: AbortSignal;
  sampleMemory?: () => void;
  testDelayMs?: number;
}

export async function analyzeTool(options: AnalysisOptions): Promise<ToolResult> {
  const input = options.tool === "get_page_semantics"
    ? pageInputSchema.parse(options.input)
    : issuesInputSchema.parse(options.input);
  if (options.testDelayMs) {
    await abortableDelay(options.testDelayMs, options.signal);
  }
  const snapshot = await createWorkspaceSnapshot(
    options.rootDirectory,
    input.entryFile,
    options.budgets,
    options.temporaryDirectory,
    options.signal,
    options.sampleMemory
  );
  try {
    options.signal.throwIfAborted();
    const result = options.tool === "get_page_semantics"
      ? await getPageSemantics(snapshot, input as PageInput, options.budgets)
      : await findSemanticIssues(snapshot, input as IssuesInput, options.budgets);
    options.sampleMemory?.();
    return result;
  } finally {
    await snapshot.dispose();
  }
}

async function getPageSemantics(
  snapshot: WorkspaceSnapshot,
  input: PageInput,
  budgets: ResourceBudgets
): Promise<PageSemanticsResult> {
  const maxItems = input.maxItems ?? 50;
  const entryFile = path.join(snapshot.snapshotRoot, snapshot.entryFile);
  const linter = new core.ProjectLinter({
    rootDir: snapshot.snapshotRoot,
    crossComponentDepth: budgets.maxDepth,
  });
  const graph = await linter.buildSemanticGraph([entryFile]);
  const model = await core.composeSemanticPageModel(graph, [
    core.createConfiguredRouteAdapter([{ route: input.route, entryFile }]),
  ]);
  const page = model.pages.find(
    (candidate) => candidate.route.state === "known" && candidate.route.value === input.route
  );
  if (!page) throw new Error("The requested route was not resolved.");

  const filePaths = new Map(
    graph.files.map((file) => [file.id, snapshotPath(snapshot, file.path)])
  );
  const componentNames = new Map(
    graph.components.map((component) => [component.id, component.name])
  );
  const components: PageSemanticsResult["components"] = [];
  if (page.componentTree) {
    collectComponents(page.componentTree, [], components, filePaths);
  }
  const files = graph.files
    .map((file) => snapshotPath(snapshot, file.path))
    .sort(stableCompare);
  const facts: PageSemanticsResult["facts"] = page.facts.map((fact) => ({
    kind: fact.kind,
    tagName: fact.tagName,
    ...(fact.value === undefined ? {} : { value: fact.value }),
    source: sourcePath(fact.provenance.fileId, filePaths),
    componentPath: fact.componentPath.map(
      (componentId) => componentNames.get(componentId) ?? componentId
    ),
  }));
  const unknowns = page.unknowns.map((unknown) => ({
    reason: unknown.reason,
    ...(unknown.message === undefined
      ? {}
      : { message: sanitizeText(snapshot, unknown.message) }),
  }));
  const truncated = {
    files: files.length > maxItems,
    components: components.length > maxItems,
    facts: facts.length > maxItems,
    unknowns: unknowns.length > maxItems,
    outputBytes: false,
  };
  const incompleteReasons = new Set(snapshot.incompleteReasons);
  if (Object.values(truncated).some(Boolean)) incompleteReasons.add("item-budget");
  if (page.unknowns.length > 0) incompleteReasons.add("semantic-unknowns");
  const result: PageSemanticsResult = {
    ...baseResult(snapshot, input.route, incompleteReasons),
    confidence: page.confidence,
    files: files.slice(0, maxItems),
    components: components.slice(0, maxItems),
    facts: facts.slice(0, maxItems),
    unknowns: unknowns.slice(0, maxItems),
    truncated,
  };
  fitPageOutput(result, budgets.maxOutputBytes);
  result.complete = result.incompleteReasons.length === 0;
  return pageSemanticsOutputSchema.parse(result);
}

async function findSemanticIssues(
  snapshot: WorkspaceSnapshot,
  input: IssuesInput,
  budgets: ResourceBudgets
): Promise<SemanticIssuesResult> {
  const maxDiagnostics = input.maxDiagnostics ?? 50;
  const entryFile = path.join(snapshot.snapshotRoot, snapshot.entryFile);
  const diagnostics = await new core.ProjectLinter({
    rootDir: snapshot.snapshotRoot,
    crossComponentAnalysis: true,
    crossComponentDepth: budgets.maxDepth,
    pages: [{ route: input.route, entryFile }],
  }).lintPageDiagnostics([entryFile]);
  const sorted = [...diagnostics].sort((left, right) =>
    stableCompare(
      [left.source.file, left.source.line, left.source.column, left.code].join("\0"),
      [right.source.file, right.source.line, right.source.column, right.code].join("\0")
    )
  );
  const incompleteReasons = new Set(snapshot.incompleteReasons);
  if (sorted.length > maxDiagnostics) incompleteReasons.add("diagnostic-budget");
  const result: SemanticIssuesResult = {
    ...baseResult(snapshot, input.route, incompleteReasons),
    diagnostics: sorted
      .slice(0, maxDiagnostics)
      .map((diagnostic) => rebaseDiagnostic(snapshot, diagnostic)),
    truncated: {
      diagnostics: sorted.length > maxDiagnostics,
      outputBytes: false,
    },
  };
  fitIssuesOutput(result, budgets.maxOutputBytes);
  result.complete = result.incompleteReasons.length === 0;
  return semanticIssuesOutputSchema.parse(result);
}

function baseResult(
  snapshot: WorkspaceSnapshot,
  route: string,
  incompleteReasons: Set<string>
) {
  return {
    versions: {
      adapter: ADAPTER_SCHEMA_VERSION,
      semanticGraph: core.SEMANTIC_GRAPH_SCHEMA_VERSION,
      pageModel: core.SEMANTIC_PAGE_MODEL_SCHEMA_VERSION,
      diagnostic: core.ZEMDOMU_DIAGNOSTIC_SCHEMA_VERSION,
    },
    workspace: {
      entryFile: snapshot.entryFile,
      fingerprint: snapshot.fingerprint,
      fileCount: snapshot.files.length,
      totalBytes: snapshot.totalBytes,
      maxDepthReached: snapshot.maxDepthReached,
    },
    route,
    complete: incompleteReasons.size === 0,
    incompleteReasons: [...incompleteReasons].sort(),
  } as const;
}

function collectComponents(
  component: CoreTypes.SemanticPageComponentTree,
  ancestors: string[],
  destination: PageSemanticsResult["components"],
  filePaths: ReadonlyMap<string, string>
): void {
  const componentPath = [...ancestors, component.name];
  destination.push({
    name: component.name,
    output: component.semanticOutput.state === "known"
      ? component.semanticOutput.tagName
      : `unknown:${component.semanticOutput.reason}`,
    source: sourcePath(component.provenance.fileId, filePaths),
    componentPath,
  });
  component.children.forEach((child) =>
    collectComponents(child, componentPath, destination, filePaths)
  );
}

function sourcePath(
  fileId: string | undefined,
  filePaths: ReadonlyMap<string, string>
): string {
  return (fileId && filePaths.get(fileId)) || "analysis";
}

function snapshotPath(snapshot: WorkspaceSnapshot, filePath: string): string {
  const absolute = path.resolve(filePath);
  const relative = path.relative(snapshot.snapshotRoot, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Core returned a source path outside the isolated snapshot.");
  }
  return relative.replace(/\\/g, "/");
}

function rebaseDiagnostic(
  snapshot: WorkspaceSnapshot,
  diagnostic: CoreTypes.ZemDomuDiagnostic
): CoreTypes.ZemDomuDiagnostic {
  const rebaseLocation = (location: CoreTypes.ZemDomuSourceLocation) => ({
    ...location,
    file: snapshotPath(snapshot, location.file),
  });
  return {
    ...diagnostic,
    message: sanitizeText(snapshot, diagnostic.message),
    source: rebaseLocation(diagnostic.source),
    ...(diagnostic.relatedLocations === undefined ? {} : {
      relatedLocations: diagnostic.relatedLocations.map((related) => ({
        ...related,
        source: rebaseLocation(related.source),
        ...(related.message === undefined
          ? {}
          : { message: sanitizeText(snapshot, related.message) }),
      })),
    }),
    ...(diagnostic.preferredEditLocation === undefined ? {} : {
      preferredEditLocation: rebaseLocation(diagnostic.preferredEditLocation),
    }),
  };
}

function sanitizeText(snapshot: WorkspaceSnapshot, value: string): string {
  return value
    .split(snapshot.snapshotRoot).join("[workspace]")
    .split(snapshot.originalRoot).join("[workspace]")
    .split(snapshot.snapshotRoot.replace(/\\/g, "/")).join("[workspace]")
    .split(snapshot.originalRoot.replace(/\\/g, "/")).join("[workspace]");
}

function fitPageOutput(result: PageSemanticsResult, maxBytes: number): void {
  const fields = ["unknowns", "facts", "components", "files"] as const;
  while (jsonBytes(result) > maxBytes) {
    const field = fields.reduce((largest, key) =>
      result[key].length > result[largest].length ? key : largest
    );
    if (result[field].length === 0) {
      throw new Error("Output metadata exceeds the configured byte budget.");
    }
    result[field].pop();
    result.truncated[field] = true;
    result.truncated.outputBytes = true;
    addIncomplete(result, "output-byte-budget");
  }
}

function fitIssuesOutput(result: SemanticIssuesResult, maxBytes: number): void {
  while (jsonBytes(result) > maxBytes && result.diagnostics.length > 0) {
    result.diagnostics.pop();
    result.truncated.diagnostics = true;
    result.truncated.outputBytes = true;
    addIncomplete(result, "output-byte-budget");
  }
  if (jsonBytes(result) > maxBytes) {
    throw new Error("Output metadata exceeds the configured byte budget.");
  }
}

function addIncomplete(result: ToolResult, reason: string): void {
  result.complete = false;
  if (!result.incompleteReasons.includes(reason)) {
    result.incompleteReasons.push(reason);
    result.incompleteReasons.sort();
  }
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function stableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
