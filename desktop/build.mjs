import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const desktop = fileURLToPath(new URL(".", import.meta.url));
const { name, version } = readJson(join(desktop, "../package.json"));
const manifest = readJson(join(desktop, "manifest.template.json"));
const output = resolve(process.argv[2] ?? `zemdomu-${version}.mcpb`);
const npmPath = process.env.npm_execpath;
assert.ok(npmPath, "Run this script with npm run desktop:build.");
const directory = mkdtempSync(join(tmpdir(), "zemdomu-desktop-"));
const npm = (args, cwd) => execFileSync(process.execPath, [npmPath, ...args], {
  cwd,
  stdio: "inherit",
});

try {
  copyFileSync(join(desktop, "icon.png"), join(directory, "icon.png"));
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({ ...manifest, version }, null, 2) + "\n");
  writeFileSync(join(directory, "package.json"), JSON.stringify({
    name: "zemdomu-claude-desktop",
    private: true,
    dependencies: { [name]: version },
  }, null, 2) + "\n");
  npm(["install", "--omit=dev", "--ignore-scripts", "--no-bin-links",
    "--registry=https://registry.npmjs.org"], directory);
  assert.equal(readJson(join(directory, "node_modules", name, "package.json")).version, version);
  npm(["exec", "--yes", "--ignore-scripts", "--package=@anthropic-ai/mcpb@2.1.2", "--",
    "mcpb", "pack", directory, join(directory, "extension.mcpb")], directory);
  copyFileSync(join(directory, "extension.mcpb"), output);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log(output);
