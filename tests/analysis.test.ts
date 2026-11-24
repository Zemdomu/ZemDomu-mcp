import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withBudgets } from "../src/config.js";
import {
  MAX_SOURCE_EXCERPT_LENGTH,
  pageSemanticsOutputSchema,
  semanticIssuesOutputSchema,
} from "../src/contracts.js";
import { AnalysisRequestError, AnalysisRunner } from "../src/runner.js";

function write(root: string, relativePath: string, content: string): string {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

function fixture(): { parent: string; root: string } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "zemdomu-analysis-"));
  const root = path.join(parent, "workspace");
  write(
    root,
    "src/Page.tsx",
    "import Child from './Child'; export default function Page(){ return <main><h1>Product</h1><Child /></main>; }"
  );
  write(
    root,
    "src/Child.tsx",
    "export default function Child(){ return <section><img /></section>; }"
  );
  return { parent, root };
}

function runner(root: string, overrides = {}) {
  return new AnalysisRunner({
    rootDirectory: root,
    budgets: withBudgets({ timeoutMs: 5_000, ...overrides }),
  });
}

test("returns schema-valid bounded semantics without source bodies or absolute paths", async (t) => {
  const { parent, root } = fixture();
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const run = await runner(root).run(
    "get_page_semantics",
    { route: "/products", entryFile: "src/Page.tsx", maxItems: 50 },
    new AbortController().signal
  );
  assert.ok("facts" in run.result);
  const result = pageSemanticsOutputSchema.parse(run.result);
  assert.equal(result.workspace.fileCount, 2);
  assert.equal(result.versions.adapter, "zd-mcp-poc/1");
  assert.ok(result.files.every((file) => !path.isAbsolute(file)));
  assert.ok(!JSON.stringify(result).includes("export default function"));
  assert.equal(result.sourceExcerpts, undefined);
  assert.equal(run.metrics.outputBytes, Buffer.byteLength(JSON.stringify(result)));
  assert.equal(run.metrics.estimatedTokens, Math.ceil(run.metrics.outputBytes / 4));
});

test("returns canonical diagnostics with workspace-relative sources", async (t) => {
  const { parent, root } = fixture();
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const run = await runner(root).run(
    "find_semantic_issues",
    { route: "/products", entryFile: "src/Page.tsx", maxDiagnostics: 50 },
    new AbortController().signal
  );
  assert.ok("diagnostics" in run.result);
  const result = semanticIssuesOutputSchema.parse(run.result);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "ZMD004"));
  assert.ok(result.diagnostics.every((diagnostic) => !path.isAbsolute(diagnostic.source.file)));
  assert.equal(result.sourceExcerpts, undefined);
});

test("maps page excerpts to retained facts and shares a location across facts", async (t) => {
  const { parent, root } = fixture();
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  write(root, "src/Page.tsx", [
    "export default function Page() {", "  return <main>",
    '    <h1 id="products">Products</h1>', "  </main>;", "}",
  ].join("\r\n"));
  const analysis = runner(root);
  const signal = new AbortController().signal;
  const input = { route: "/products", entryFile: "src/Page.tsx", maxSourceExcerpts: 2 };
  const page = pageSemanticsOutputSchema.parse((await analysis.run("get_page_semantics", input, signal)).result);
  const heading = page.sourceExcerpts?.items.find((item) => item.startLine === 3);
  assert.ok(heading);
  assert.equal(heading.file, "src/Page.tsx");
  assert.equal(heading.startColumn, 1);
  assert.match(heading.text, /^    <h1 id="products">Products<\/h1>\n/);
  assert.deepEqual(heading.itemIndexes.map((index) => page.facts[index]?.kind), ["heading", "document-id"]);

  const limited = pageSemanticsOutputSchema.parse((await analysis.run(
    "get_page_semantics", { ...input, maxSourceExcerpts: 1 }, signal
  )).result);
  assert.equal(limited.sourceExcerpts?.items.length, 1);
  assert.equal(limited.sourceExcerpts?.truncated, true);

  const disabled = pageSemanticsOutputSchema.parse((await analysis.run(
    "get_page_semantics", { ...input, maxSourceExcerpts: 0 }, signal
  )).result);
  assert.equal(disabled.sourceExcerpts, undefined);
});

test("clips diagnostic excerpts around the source column in a captured dependency", async (t) => {
  const { parent, root } = fixture();
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const imageLine = `    {/* ${"😀".repeat(140)} */}<img src="product.png" />`;
  write(root, "src/Child.tsx", [
    "export default function Child() {", "  return <section>", imageLine,
    "  </section>;", "}", "// outside the excerpt",
  ].join("\n"));
  const version = await runner(root).run(
    "find_semantic_issues", { route: "/products", entryFile: "src/Page.tsx", maxSourceExcerpts: 12 },
    new AbortController().signal
  );
  const result = semanticIssuesOutputSchema.parse(version.result);
  const image = result.diagnostics.findIndex((item) => item.code === "ZMD004");
  assert.ok(image >= 0);
  const excerpt = result.sourceExcerpts?.items.find((item) => item.itemIndexes.includes(image));
  assert.ok(excerpt);
  assert.equal(excerpt.file, "src/Child.tsx");
  assert.equal(excerpt.startLine, 3);
  assert.ok(excerpt.startColumn > 1);
  assert.match(excerpt.text, /<img src="product.png" \/>/);
  assert.ok(excerpt.text.startsWith(imageLine.slice(excerpt.startColumn - 1)));
  assert.ok(excerpt.text.length <= MAX_SOURCE_EXCERPT_LENGTH);
  assert.ok(!excerpt.text.includes("outside the excerpt"));
});

test("drops excerpts before diagnostics when the output budget is tight", async (t) => {
  const { parent, root } = fixture();
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const input = { route: "/products", entryFile: "src/Page.tsx" };
  const signal = new AbortController().signal;
  const ordinary = semanticIssuesOutputSchema.parse((await runner(root).run("find_semantic_issues", input, signal)).result);
  const maxOutputBytes = Buffer.byteLength(JSON.stringify(ordinary)) + 60;
  const extra = await runner(root, { maxOutputBytes }).run(
    "find_semantic_issues", { ...input, maxSourceExcerpts: 12 }, signal
  );
  const { sourceExcerpts, ...result } = semanticIssuesOutputSchema.parse(extra.result);
  assert.deepEqual(result, ordinary);
  assert.deepEqual(sourceExcerpts, { items: [], truncated: true });
  assert.ok(extra.metrics.outputBytes <= maxOutputBytes);
});

test("analyzes an HTML entry without following its script sources", async (t) => {
  const { parent, root } = fixture();
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  write(root, "index.html", '<html lang="en"><head><title>Home</title></head><body><main><h1>Home</h1><img src="image.png"></main><script src="/app.js"></script></body></html>');
  const { result } = await runner(root).run(
    "find_semantic_issues",
    { route: "/", entryFile: "index.html" },
    new AbortController().signal
  );
  const issues = semanticIssuesOutputSchema.parse(result);
  assert.equal(issues.workspace.fileCount, 1);
  assert.ok(issues.diagnostics.some((diagnostic) => diagnostic.code === "ZMD004"));
});

test("uses workspace tsconfig aliases for component facts and diagnostics", async (t) => {
  const { parent, root } = fixture();
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  write(root, "tsconfig.json", '{ // Workspace aliases\n "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }');
  write(root, "src/Page.tsx", "import Child from '@/Child'; export default function Page(){ return <main><Child /></main>; }");
  const input = { route: "/", entryFile: "src/Page.tsx" };
  const analysis = runner(root);
  const signal = new AbortController().signal;
  const page = pageSemanticsOutputSchema.parse((await analysis.run("get_page_semantics", input, signal)).result);
  assert.deepEqual(page.files, ["src/Child.tsx", "src/Page.tsx"]);
  assert.ok(page.components.some((component) => component.source === "src/Child.tsx"));
  const issues = semanticIssuesOutputSchema.parse((await analysis.run("find_semantic_issues", input, signal)).result);
  assert.ok(issues.diagnostics.some((diagnostic) =>
    diagnostic.code === "ZMD004" && diagnostic.source.file === "src/Child.tsx"));
});

test("rejects import candidates that cross the workspace boundary", async (t) => {
  const { parent, root } = fixture();
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const input = { route: "/", entryFile: "src/Page.tsx" };
  const analysis = runner(root);
  const signal = new AbortController().signal;
  write(root, "tsconfig.json", '{"compilerOptions":{"paths":{"@outside/*":["../outside/*"]}}}');
  write(root, input.entryFile, "import Child from '@outside/Child'; export default function Page(){ return <Child />; }");
  await assert.rejects(analysis.run("get_page_semantics", input, signal), /escapes the configured workspace root/);

  write(root, input.entryFile, "import Child from '/outside/Child'; export default function Page(){ return <Child />; }");
  await assert.rejects(analysis.run("get_page_semantics", input, signal), /workspace-relative imports/);
});

test("rejects a transitive directory-symlink escape before reading the dependency", async (t) => {
  const { parent, root } = fixture();
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const outside = path.join(parent, "outside");
  write(outside, "Outside.tsx", "export default function Outside(){ return <main />; }");
  const link = path.join(root, "src", "linked");
  fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  write(
    root,
    "src/EscapePage.tsx",
    "import Outside from './linked/Outside'; export default function Page(){ return <Outside />; }"
  );

  await assert.rejects(
    runner(root).run(
      "get_page_semantics",
      { route: "/escape", entryFile: "src/EscapePage.tsx" },
      new AbortController().signal
    ),
    /escapes the configured workspace root/
  );
});

test("signals file, depth, and output budget truncation explicitly", async (t) => {
  const { parent, root } = fixture();
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));

  const fileLimited = await runner(root, { maxFiles: 1 }).run(
    "get_page_semantics",
    { route: "/products", entryFile: "src/Page.tsx" },
    new AbortController().signal
  );
  assert.ok(fileLimited.result.incompleteReasons.includes("file-count-budget"));
  assert.equal(fileLimited.result.complete, false);

  write(root, "src/Grand.tsx", "export default function Grand(){ return <aside />; }");
  write(
    root,
    "src/Child.tsx",
    "import Grand from './Grand'; export default function Child(){ return <section><Grand /></section>; }"
  );
  const depthLimited = await runner(root, { maxDepth: 1 }).run(
    "get_page_semantics",
    { route: "/products", entryFile: "src/Page.tsx" },
    new AbortController().signal
  );
  assert.ok(depthLimited.result.incompleteReasons.includes("depth-budget"));

  const outputLimited = await runner(root, { maxOutputBytes: 650 }).run(
    "get_page_semantics",
    { route: "/products", entryFile: "src/Page.tsx", maxItems: 200 },
    new AbortController().signal
  );
  assert.ok(outputLimited.result.incompleteReasons.includes("output-byte-budget"));
  const truncated = pageSemanticsOutputSchema.parse(outputLimited.result).truncated;
  assert.equal(truncated.outputBytes, true);
  assert.ok(truncated.files || truncated.components || truncated.facts || truncated.unknowns);
  assert.ok(Buffer.byteLength(JSON.stringify(outputLimited.result)) <= 650);
});

test("enforces timeout, cancellation, and concurrency budgets by terminating workers", async (t) => {
  const { parent, root } = fixture();
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const input = { route: "/products", entryFile: "src/Page.tsx" } as const;
  const temporaryDirectories: string[] = [];
  const trackTemporaryDirectory = (directory: string) => {
    temporaryDirectories.push(directory);
  };

  await assert.rejects(
    runner(root, { timeoutMs: 30 }).run(
      "get_page_semantics",
      input,
      new AbortController().signal,
      { delayMs: 500, onTemporaryDirectory: trackTemporaryDirectory }
    ),
    (error: unknown) => error instanceof AnalysisRequestError && error.code === "timeout"
  );

  const cancellation = new AbortController();
  const cancelled = runner(root).run(
    "get_page_semantics",
    input,
    cancellation.signal,
    { delayMs: 500, onTemporaryDirectory: trackTemporaryDirectory }
  );
  setTimeout(() => cancellation.abort(), 20);
  await assert.rejects(
    cancelled,
    (error: unknown) => error instanceof AnalysisRequestError && error.code === "cancelled"
  );

  const concurrencyRunner = runner(root);
  const first = concurrencyRunner.run(
    "get_page_semantics",
    input,
    new AbortController().signal,
    { delayMs: 100, onTemporaryDirectory: trackTemporaryDirectory }
  );
  await assert.rejects(
    concurrencyRunner.run(
      "find_semantic_issues",
      input,
      new AbortController().signal
    ),
    (error: unknown) => error instanceof AnalysisRequestError && error.code === "busy"
  );
  await first;
  assert.equal(concurrencyRunner.activeCount, 0);
  assert.ok(temporaryDirectories.length >= 3);
  assert.ok(temporaryDirectories.every((directory) => !fs.existsSync(directory)));
});
