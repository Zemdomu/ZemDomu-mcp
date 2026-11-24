import * as z from "zod/v4";

export const ADAPTER_SCHEMA_VERSION = "zd-mcp-poc/1" as const;

export const pageInputSchema = z.object({
  route: z.string().min(1).max(256).startsWith("/"),
  entryFile: z.string().min(1).max(1024),
  maxItems: z.number().int().min(1).max(200).optional(),
}).strict();

export const issuesInputSchema = z.object({
  route: z.string().min(1).max(256).startsWith("/"),
  entryFile: z.string().min(1).max(1024),
  maxDiagnostics: z.number().int().min(1).max(200).optional(),
}).strict();

const sourceLocationSchema = z.object({
  file: z.string(),
  line: z.number().int().nonnegative(),
  column: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative().optional(),
}).strict();

const diagnosticSchema = z.object({
  schemaVersion: z.literal("1.0"),
  rule: z.string(),
  code: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
  source: sourceLocationSchema,
  page: z.string().optional(),
  componentPath: z.array(z.string()).optional(),
  relatedLocations: z.array(z.object({
    source: sourceLocationSchema,
    message: z.string().optional(),
  }).strict()).optional(),
  preferredEditLocation: sourceLocationSchema.optional(),
  suggestion: z.object({
    message: z.string(),
    replacement: z.string().optional(),
  }).strict().optional(),
  provenance: z.object({
    kind: z.enum(["source", "cross-component", "inference"]),
    analyzer: z.string().optional(),
    description: z.string().optional(),
  }).strict().optional(),
  confidence: z.enum(["certain", "inferred", "unknown"]).optional(),
}).strict();

const workspaceSchema = z.object({
  entryFile: z.string(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  maxDepthReached: z.number().int().nonnegative(),
}).strict();

const versionsSchema = z.object({
  adapter: z.literal(ADAPTER_SCHEMA_VERSION),
  semanticGraph: z.literal("1.0"),
  pageModel: z.literal("1.0"),
  diagnostic: z.literal("1.0"),
}).strict();

const baseResultSchema = z.object({
  versions: versionsSchema,
  workspace: workspaceSchema,
  route: z.string(),
  complete: z.boolean(),
  incompleteReasons: z.array(z.string()),
}).strict();

export const pageSemanticsOutputSchema = baseResultSchema.extend({
  confidence: z.enum(["certain", "inferred", "unknown"]),
  files: z.array(z.string()),
  components: z.array(z.object({
    name: z.string(),
    output: z.string(),
    source: z.string(),
    componentPath: z.array(z.string()),
  }).strict()),
  facts: z.array(z.object({
    kind: z.enum(["heading", "landmark", "section", "navigation", "document-id"]),
    tagName: z.string(),
    value: z.union([z.string(), z.number()]).optional(),
    source: z.string(),
    componentPath: z.array(z.string()),
  }).strict()),
  unknowns: z.array(z.object({
    reason: z.string(),
    message: z.string().optional(),
  }).strict()),
  truncated: z.object({
    files: z.boolean(),
    components: z.boolean(),
    facts: z.boolean(),
    unknowns: z.boolean(),
    outputBytes: z.boolean(),
  }).strict(),
}).strict();

export const semanticIssuesOutputSchema = baseResultSchema.extend({
  diagnostics: z.array(diagnosticSchema),
  truncated: z.object({
    diagnostics: z.boolean(),
    outputBytes: z.boolean(),
  }).strict(),
}).strict();

export type PageInput = z.infer<typeof pageInputSchema>;
export type IssuesInput = z.infer<typeof issuesInputSchema>;
export type PageSemanticsResult = z.infer<typeof pageSemanticsOutputSchema>;
export type SemanticIssuesResult = z.infer<typeof semanticIssuesOutputSchema>;
export type ToolName = "get_page_semantics" | "find_semantic_issues";
export type ToolInput = PageInput | IssuesInput;
export type ToolResult = PageSemanticsResult | SemanticIssuesResult;

export const READONLY_TOOL_NAMES: readonly ToolName[] = [
  "get_page_semantics",
  "find_semantic_issues",
];
