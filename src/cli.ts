#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { withBudgets } from "./config.js";
import { canonicalRoot } from "./path-policy.js";
import { createZemDomuMcpServer } from "./server.js";

const usage = "Usage: zemdomu-mcp --root <workspace-directory>";
const args = process.argv.slice(2);

if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  console.log(usage);
} else if (args.length !== 2 || args[0] !== "--root" || !args[1]) {
  console.error(usage);
  process.exitCode = 1;
} else {
  try {
    const configuration = { rootDirectory: await canonicalRoot(args[1]), budgets: withBudgets() };
    serveStdio(() => createZemDomuMcpServer(configuration), {
      legacy: "serve",
      onerror: (error) => console.error(`ZemDomu MCP error: ${error.message}`),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Could not start ZemDomu MCP: ${message}`);
    process.exitCode = 1;
  }
}
