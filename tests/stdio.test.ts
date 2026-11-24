import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  pageSemanticsOutputSchema,
  READONLY_TOOL_NAMES,
  semanticIssuesOutputSchema,
} from "../src/contracts.js";

const cli = process.env.ZEMDOMU_MCP_TEST_CLI ?? fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("CLI validates its root before serving stdio", () => {
  const options = { encoding: "utf8" } as const;
  const help = spawnSync(process.execPath, [cli, "--help"], options);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /zemdomu-mcp --root/);
  const invalid = spawnSync(process.execPath, [cli, "--root", cli], options);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /Configured root must be a directory/);
});

for (const protocol of ["2026-07-28", "2025-11-25"] as const) {
  test(`stdio ${protocol} lists and calls both read-only tools`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zemdomu-stdio-"));
    const entry = path.join(root, "Page.tsx");
    fs.writeFileSync(
      entry,
      "export default function Page(){ return <main><h1>Home</h1><img /></main>; }",
      "utf8"
    );
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, "--root", root],
      stderr: "pipe",
    });
    const client = new Client(
      { name: "zemdomu-mcp-test-client", version: "1.0.0" },
      protocol === "2026-07-28"
        ? { versionNegotiation: { mode: { pin: protocol } } }
        : { supportedProtocolVersions: [protocol] }
    );
    t.after(async () => client.close());
    await client.connect(transport);
    assert.equal(client.getNegotiatedProtocolVersion(), protocol);

    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      [...READONLY_TOOL_NAMES].sort()
    );
    assert.ok(listed.tools.every((tool) => tool.annotations?.readOnlyHint === true));
    assert.ok(listed.tools.every((tool) => tool.annotations?.destructiveHint === false));

    const semantics = await client.callTool({
      name: "get_page_semantics",
      arguments: { route: "/", entryFile: "Page.tsx", maxItems: 20 },
    });
    assert.equal(semantics.isError, undefined);
    const page = pageSemanticsOutputSchema.parse(semantics.structuredContent);
    assert.ok(page.facts.some((fact) => fact.kind === "heading"));
    assert.deepEqual(semantics.content, [{ type: "text", text: JSON.stringify(page) }]);

    const issues = await client.callTool({
      name: "find_semantic_issues",
      arguments: { route: "/", entryFile: "Page.tsx" },
    });
    assert.equal(issues.isError, undefined);
    const result = semanticIssuesOutputSchema.parse(issues.structuredContent);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "ZMD004"));
    assert.deepEqual(issues.content, [{ type: "text", text: JSON.stringify(result) }]);

    for (const name of READONLY_TOOL_NAMES) {
      const response = await client.callTool({
        name,
        arguments: { route: "/", entryFile: "Page.tsx", maxSourceExcerpts: 2 },
      });
      assert.equal(response.isError, undefined);
      const schema = name === "get_page_semantics" ? pageSemanticsOutputSchema : semanticIssuesOutputSchema;
      const withExcerpts = schema.parse(response.structuredContent);
      assert.ok(withExcerpts.sourceExcerpts?.items.some((item) => item.file === "Page.tsx" && item.startLine === 1));
      assert.deepEqual(response.content, [{ type: "text", text: JSON.stringify(withExcerpts) }]);
    }

    const invalid = await client.callTool({
      name: "find_semantic_issues",
      arguments: { route: "/", entryFile: "../Page.tsx" },
    });
    assert.equal(invalid.isError, true);
  });
}
