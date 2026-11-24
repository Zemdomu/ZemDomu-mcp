# ZemDomu MCP

> Semantic accessibility checks for GitHub Copilot in VS Code and other MCP clients.

ZemDomu MCP uses [ZemDomu Core (`zemdomu` on npm)](https://www.npmjs.com/package/zemdomu) to
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
        "zemdomu-mcp@0.1.1",
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

For Codex, Claude Code, and Cursor, see the
[coding assistant setup guide](https://zemdomu.dev/docs/installation/mcp).

## Claude Desktop

Open the `.mcpb` bundle with Claude Desktop, review the extension details,
and choose the **Project folder** you want to analyze. The bundle includes
the server and its dependencies. It uses Claude Desktop's Node.js runtime
and needs version 22.17 or later.

If Claude can't see the tools, check that ZemDomu is enabled under **Settings
→ Desktop app → Extensions** and that **Project folder** points to the folder
containing your source files. Pass entry paths relative to that folder.

To build the bundle from this repository, run these commands from the
repository root with Node.js 22.17 or later.

```bash
npm ci --prefix desktop --omit=dev --ignore-scripts --no-bin-links
npm exec --yes --package=@anthropic-ai/mcpb@2.1.2 -- mcpb pack desktop zemdomu-0.1.1.mcpb
```

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

Try one of these requests in your assistant. You can use the sample without
an account for ZemDomu or a separate ZemDomu API key.

```text
Use ZemDomu to inspect the page structure and find accessibility issues
for route /products using Products.tsx as the entry file.
```

```text
Use ZemDomu to list the headings and landmarks for /products from Products.tsx.
```

```text
Run ZemDomu's accessibility diagnostics on Products.tsx for /products.
Give me each finding's rule code and source location.
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

### Request short source excerpts

Set `maxSourceExcerpts` on either tool to include code around the reported
facts or findings. It accepts 0 to 12 and defaults to 0. Start with a few
excerpts when asking an assistant to review or fix a page.

```json
{
  "route": "/products",
  "entryFile": "src/pages/Products.tsx",
  "maxDiagnostics": 10,
  "maxSourceExcerpts": 4
}
```

`sourceExcerpts.items` contains up to three lines and 240 characters per
excerpt. Each excerpt has a workspace-relative file, one-based `startLine`
and `startColumn`, and zero-based `itemIndexes` into the returned `facts` or
`diagnostics` array. Diagnostics can also include excerpts for related and
preferred edit locations. Shared excerpts appear once. The response budget
trims excerpts before findings and marks `sourceExcerpts.truncated` when it
can fit that field.

## Workspace and data

The server reads the selected entry and supported local dependencies under the
folder passed to `--root`. Analysis runs locally in a temporary copy so your
workspace stays unchanged. The server returns findings and any requested
source excerpts to your MCP client, which can include them in requests to its
model provider. See the
[Claude Desktop extension privacy notice](https://zemdomu.dev/privacy#claude-desktop)
or the [ZemDomu for Codex privacy policy](https://zemdomu.dev/privacy/codex).

For support, [open a GitHub issue](https://github.com/Zemdomu/ZemDomu-mcp/issues).
Report security concerns privately to [hello@zemdomu.dev](mailto:hello@zemdomu.dev).

## License

[MIT](LICENSE)
