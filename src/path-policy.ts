import { promises as fs } from "node:fs";
import path from "node:path";

export function isContainedPath(
  root: string,
  candidate: string,
  implementation: path.PlatformPath = path
): boolean {
  const normalize = (value: string) => {
    const resolved = implementation.resolve(value);
    return implementation === path.win32 ? resolved.toLowerCase() : resolved;
  };
  const normalizedRoot = normalize(root);
  const normalizedCandidate = normalize(candidate);
  const relative = implementation.relative(normalizedRoot, normalizedCandidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${implementation.sep}`) &&
    !implementation.isAbsolute(relative)
  );
}

export function assertWorkspaceRelative(entryFile: string): void {
  if (
    !entryFile ||
    entryFile.includes("\0") ||
    path.posix.isAbsolute(entryFile) ||
    path.win32.isAbsolute(entryFile) ||
    /^[a-z]:/i.test(entryFile)
  ) {
    throw new TypeError("entryFile must be a non-empty workspace-relative path.");
  }
  const segments = entryFile.replace(/\\/g, "/").split("/");
  if (segments.includes("..")) {
    throw new Error("Requested analysis escapes the configured workspace root.");
  }
}

export async function canonicalRoot(rootDirectory: string): Promise<string> {
  const root = await fs.realpath(path.resolve(rootDirectory));
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new TypeError("Configured root must be a directory.");
  return root;
}

export async function canonicalInside(
  root: string,
  candidate: string
): Promise<string> {
  workspacePath(root, candidate);
  const canonical = await fs.realpath(candidate);
  if (!isContainedPath(root, canonical)) {
    throw new Error("Requested analysis escapes the configured workspace root.");
  }
  return canonical;
}

export function workspacePath(root: string, candidate: string): string {
  if (!isContainedPath(root, candidate)) {
    throw new Error("Requested analysis escapes the configured workspace root.");
  }
  return path.relative(root, candidate).replace(/\\/g, "/");
}
