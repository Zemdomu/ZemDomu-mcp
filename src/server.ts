import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/server";
import type { ServerConfiguration } from "./config.js";
import {
  issuesInputSchema,
  pageInputSchema,
  pageSemanticsOutputSchema,
  semanticIssuesOutputSchema,
} from "./contracts.js";
import { AnalysisRunner } from "./runner.js";

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };

export function createZemDomuMcpServer(configuration: ServerConfiguration): McpServer {
  const runner = new AnalysisRunner(configuration);
  const server = new McpServer({
    name: "zemdomu-mcp",
    version,
  });

  server.registerTool(
    "get_page_semantics",
    {
      title: "Get page semantics",
      description:
        "Return bounded component and semantic facts for one workspace-relative page entry. Set maxSourceExcerpts to get short code excerpts for the facts.",
      inputSchema: pageInputSchema,
      outputSchema: pageSemanticsOutputSchema,
      annotations,
    },
    async (input, context) => {
      try {
        const { result } = await runner.run(
          "get_page_semantics",
          input,
          context.mcpReq.signal
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "find_semantic_issues",
    {
      title: "Find semantic issues",
      description:
        "Return bounded ZemDomu diagnostics for one workspace-relative page entry. Set maxSourceExcerpts to get short code excerpts for findings and related edit locations.",
      inputSchema: issuesInputSchema,
      outputSchema: semanticIssuesOutputSchema,
      annotations,
    },
    async (input, context) => {
      try {
        const { result } = await runner.run(
          "find_semantic_issues",
          input,
          context.mcpReq.signal
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toolError(error);
      }
    }
  );

  return server;
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : "Analysis failed.";
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}
