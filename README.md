# ZemDomu MCP

> Semantic accessibility checks for GitHub Copilot in VS Code and other MCP clients.

ZemDomu MCP uses [ZemDomu Core](https://github.com/Zemdomu/ZemDomu-core) to
inspect page structure and report accessibility diagnostics with source
locations. It analyzes HTML, JSX, TSX, JavaScript, TypeScript, and Vue page
entries and follows supported React and Vue component imports.

## Set up in VS Code

Use Node.js 22.17 or later. Select Copilot in VS Code Chat and open the
project folder you want to analyze. For the npm release, add this entry to
your [Copilot configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)
in `~/.copilot/mcp-config.json`. Replace the example path with the absolute
path to your project. If the file already exists, add `zemdomu` to its
`mcpServers` object.

```json
{
  "mcpServers": {
    "zemdomu": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "--yes",
        "--package",
        "@zemdomu/mcp@0.1.0",
        "zemdomu-mcp",
        "--root",
        "/absolute/path/to/your/project"
      ],
      "tools": ["get_page_semantics", "find_semantic_issues"]
    }
  }
}
```

Find ZemDomu under **MCP Servers** in `Chat: Open Customizations`. Review
the command before trusting the server.

For archive installation and Codex registration, see the
[Codex setup guide](https://zemdomu.dev/docs/installation/mcp).

## Analyze a page

To try both tools, save this as `Products.tsx` in the workspace root.

```tsx
export default function Products() {
  return (
    <main>
      <h1>Products</h1>
      <img src="product.webp" />
    </main>
  );
}
```

Ask Copilot to run both checks.

```text
Use ZemDomu to inspect the page structure and find accessibility issues
for route /products using Products.tsx as the entry file.
```

The page structure includes the main landmark and an `h1` heading.
ZemDomu reports `ZMD004` at the image because it is missing an `alt` attribute.

## Tools

| Tool | Returns | Optional limit |
| --- | --- | --- |
| `get_page_semantics` | Headings, landmarks, component relationships, and unresolved source patterns | `maxItems` per collection |
| `find_semantic_issues` | ZemDomu diagnostics with workspace-relative file locations | `maxDiagnostics` |

Both tools take a route that starts with `/` and an entry file relative to the
workspace. Each limit accepts 1 to 200 and defaults to 50. Check
`complete`, `incompleteReasons`, and `truncated` before you
rely on the result. Use rendered browser, keyboard, and assistive-technology
testing to check the experience in the running app.

## Workspace and data

The server reads the selected entry and supported local dependencies under the
folder passed to `--root`. Analysis runs locally in a temporary copy so your
workspace stays unchanged. The server returns source-derived findings to your
MCP client, which can include them in requests to its model provider. See the
[ZemDomu for Codex privacy policy](https://zemdomu.dev/privacy/codex).

## License

[MIT](LICENSE)
