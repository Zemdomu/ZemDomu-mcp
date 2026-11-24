import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import * as z from "zod/v4";
import type { ResourceBudgets } from "./config.js";
import {
  assertWorkspaceRelative,
  canonicalInside,
  canonicalRoot,
  isContainedPath,
  workspacePath,
} from "./path-policy.js";

const SUPPORTED_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".vue"];
const ENTRY_EXTENSIONS = [...SUPPORTED_EXTENSIONS, ".html", ".htm"];
const MAX_CONFIG_BYTES = 128 * 1024;
const configSchema = z.object({
  extends: z.unknown().optional(),
  compilerOptions: z.object({
    baseUrl: z.string().optional(),
    paths: z.record(z.string(), z.array(z.string())).optional(),
  }).optional(),
});

export interface SnapshotFile {
  relativePath: string;
  bytes: number;
  depth: number;
  content: string;
}

export interface WorkspaceSnapshot {
  originalRoot: string;
  snapshotRoot: string;
  entryFile: string;
  files: SnapshotFile[];
  totalBytes: number;
  maxDepthReached: number;
  fingerprint: string;
  incompleteReasons: string[];
  dispose(): Promise<void>;
}

interface PendingFile {
  candidate: string;
  depth: number;
}

export async function createWorkspaceSnapshot(
  rootDirectory: string,
  entryFile: string,
  budgets: ResourceBudgets,
  temporaryDirectory: string,
  signal: AbortSignal,
  sampleMemory: () => void = () => undefined
): Promise<WorkspaceSnapshot> {
  assertWorkspaceRelative(entryFile);
  const root = await canonicalRoot(rootDirectory);
  const entry = path.resolve(root, entryFile.replace(/\\/g, "/"));
  if (!hasExtension(entry, ENTRY_EXTENSIONS)) {
    throw new TypeError("Analysis entries must be HTML, JSX, TSX, JavaScript, TypeScript, or Vue files.");
  }
  const canonicalTemporaryDirectory = await canonicalRoot(temporaryDirectory);
  if (!isContainedPath(await fs.realpath(os.tmpdir()), canonicalTemporaryDirectory)) {
    throw new Error("The analysis temporary directory is outside the OS temp root.");
  }
  const snapshotRoot = await fs.mkdtemp(
    path.join(canonicalTemporaryDirectory, "snapshot-")
  );
  const dispose = async () => {
    if (
      snapshotRoot === canonicalTemporaryDirectory ||
      !isContainedPath(canonicalTemporaryDirectory, snapshotRoot)
    ) {
      throw new Error("Refusing to remove an unsafe snapshot path.");
    }
    await fs.rm(snapshotRoot, { recursive: true, force: true });
  };
  const files: SnapshotFile[] = [];
  const incomplete = new Set<string>();
  const seen = new Set<string>();
  const pending: PendingFile[] = [{ candidate: entry, depth: 0 }];
  const resolvedAliases = new Map<string, string[]>();
  let totalBytes = 0;
  let maxDepthReached = 0;

  try {
    const { baseUrl, paths } = await loadAliases(root, incomplete);
    while (pending.length > 0) {
      signal.throwIfAborted();
      sampleMemory();
      const current = pending.pop()!;
      const key = process.platform === "win32" ? current.candidate.toLowerCase() : current.candidate;
      if (seen.has(key)) continue;
      if (files.length >= budgets.maxFiles) {
        incomplete.add("file-count-budget");
        break;
      }

      const data = await readWorkspaceFile(
        root, current.candidate, budgets.maxTotalBytes - totalBytes, ENTRY_EXTENSIONS
      );
      if (data === undefined) {
        incomplete.add("byte-budget");
        break;
      }
      const content = data.toString("utf8");
      const bytes = Buffer.byteLength(content);
      if (bytes > budgets.maxTotalBytes - totalBytes) {
        incomplete.add("byte-budget");
        break;
      }

      seen.add(key);
      totalBytes += Math.max(bytes, data.byteLength);
      maxDepthReached = Math.max(maxDepthReached, current.depth);
      const relativePath = workspacePath(root, current.candidate);
      files.push({ relativePath, bytes, depth: current.depth, content });

      for (const specifier of importSpecifiers(relativePath, content).reverse()) {
        if (path.posix.isAbsolute(specifier) || path.win32.isAbsolute(specifier) || /^[a-z]:/i.test(specifier)) {
          throw new Error("Analysis only follows workspace-relative imports and configured aliases.");
        }
        const relativeImport = specifier.startsWith(".");
        const bases = relativeImport
          ? [path.resolve(path.dirname(current.candidate), specifier)]
          : aliasTargets(paths, specifier).map((target) => path.resolve(baseUrl, target));
        if (bases.length === 0) continue;
        bases.forEach((base) => workspacePath(root, base));
        if (current.depth >= budgets.maxDepth) {
          incomplete.add("depth-budget");
          continue;
        }
        let resolved: string | undefined;
        for (const base of bases) {
          resolved = await resolveLocalImport(root, base);
          if (resolved) break;
        }
        if (!resolved) {
          if (bases.some((base) => !path.extname(base) || hasExtension(base, SUPPORTED_EXTENSIONS))) {
            incomplete.add("unresolved-local-import");
          }
          continue;
        }
        if (!relativeImport) resolvedAliases.set(specifier, [workspacePath(root, resolved)]);
        pending.push({ candidate: resolved, depth: current.depth + 1 });
      }
    }

    signal.throwIfAborted();
    for (const file of files) {
      const destination = path.join(snapshotRoot, file.relativePath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, file.content, { encoding: "utf8", flag: "wx" });
    }
    const snapshotConfig = JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: Object.fromEntries([...resolvedAliases].sort()) },
    });
    await fs.writeFile(path.join(snapshotRoot, "tsconfig.json"), snapshotConfig, { flag: "wx" });

    const requestedEntry = workspacePath(root, entry);
    if (!files.some((file) => file.relativePath === requestedEntry)) {
      throw new Error("The entry file could not be captured within resource budgets.");
    }
    const fingerprint = createHash("sha256");
    fingerprint.update(snapshotConfig).update("\0");
    for (const file of [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
      fingerprint.update(file.relativePath);
      fingerprint.update("\0");
      fingerprint.update(file.content);
      fingerprint.update("\0");
    }

    return {
      originalRoot: root,
      snapshotRoot,
      entryFile: requestedEntry,
      files,
      totalBytes,
      maxDepthReached,
      fingerprint: fingerprint.digest("hex"),
      incompleteReasons: [...incomplete].sort(),
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function readWorkspaceFile(
  root: string,
  candidate: string,
  maxBytes: number,
  extensions?: readonly string[]
): Promise<Buffer | undefined> {
  const canonical = await canonicalInside(root, candidate);
  if (extensions && !hasExtension(canonical, extensions)) {
    throw new TypeError("The analysis file resolves to an unsupported source type.");
  }
  const handle = await openReadOnly(canonical);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new TypeError("Analysis inputs must be regular files.");
    if (stat.size > maxBytes) return undefined;
    const chunks: Buffer[] = [];
    let remaining = maxBytes + 1;
    while (remaining > 0) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      remaining -= bytesRead;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    if (!samePath(canonical, await canonicalInside(root, candidate))) {
      throw new Error("Workspace path changed during analysis.");
    }
    return remaining === 0 ? undefined : Buffer.concat(chunks);
  } finally {
    await handle.close();
  }
}

async function openReadOnly(filePath: string) {
  try {
    return await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EINVAL") {
      return fs.open(filePath, constants.O_RDONLY);
    }
    throw error;
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

async function loadAliases(root: string, incomplete: Set<string>) {
  const empty = { baseUrl: root, paths: {} as Record<string, string[]> };
  let data: Buffer | undefined;
  try {
    data = await readWorkspaceFile(root, path.join(root, "tsconfig.json"), MAX_CONFIG_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
    throw error;
  }
  if (data === undefined) {
    incomplete.add("tsconfig-byte-budget");
    return empty;
  }
  const parsed = ts.parseConfigFileTextToJson("tsconfig.json", data.toString("utf8"));
  const config = configSchema.safeParse(parsed.config);
  if (parsed.error || !config.success) {
    incomplete.add("invalid-tsconfig");
    return empty;
  }
  if (config.data.extends !== undefined) incomplete.add("tsconfig-extends");
  const { baseUrl = ".", paths = {} } = config.data.compilerOptions ?? {};
  return { baseUrl: path.resolve(root, baseUrl), paths };
}

function aliasTargets(paths: Record<string, string[]>, specifier: string): string[] {
  if (Object.hasOwn(paths, specifier)) return paths[specifier];
  let match: { prefixLength: number; wildcard: string; targets: string[] } | undefined;
  for (const [pattern, targets] of Object.entries(paths)) {
    const [prefix, suffix, extra] = pattern.split("*");
    if (suffix === undefined || extra !== undefined || prefix.length <= (match?.prefixLength ?? -1)) continue;
    if (specifier.length < prefix.length + suffix.length || !specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    match = { prefixLength: prefix.length, wildcard: specifier.slice(prefix.length, specifier.length - suffix.length), targets };
  }
  if (!match) return [];
  const { targets, wildcard } = match;
  return targets.map((target) => target.replace("*", () => wildcard));
}

function hasExtension(file: string, extensions: readonly string[]): boolean {
  return extensions.includes(path.extname(file).toLowerCase());
}

function importSpecifiers(filePath: string, content: string): string[] {
  if (!hasExtension(filePath, SUPPORTED_EXTENSIONS)) return [];
  const source = path.extname(filePath).toLowerCase() === ".vue"
    ? [...content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
        .map((match) => match[1])
        .join("\n")
    : content;
  return [...new Set(ts.preProcessFile(source, true, true).importedFiles.map((entry) => entry.fileName))];
}

async function resolveLocalImport(root: string, base: string): Promise<string | undefined> {
  const candidates = [
    ...(hasExtension(base, SUPPORTED_EXTENSIONS) ? [base] : []),
    ...SUPPORTED_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SUPPORTED_EXTENSIONS.map((extension) => path.join(base, `index${extension}`)),
  ];
  for (const candidate of candidates) {
    try {
      const canonical = await canonicalInside(root, candidate);
      const stat = await fs.stat(canonical);
      if (stat.isFile()) return candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw error;
    }
  }
  return undefined;
}
