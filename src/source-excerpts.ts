import { MAX_SOURCE_EXCERPT_LENGTH, type SourceExcerpts } from "./contracts.js";
import type { WorkspaceSnapshot } from "./snapshot.js";

export interface ExcerptLocation {
  file: string;
  line: number;
  column: number;
  itemIndex: number;
}

export function collectSourceExcerpts(
  snapshot: WorkspaceSnapshot,
  locations: Iterable<ExcerptLocation>,
  limit: number
): SourceExcerpts {
  const sources = new Map(snapshot.files.map((file) => [file.relativePath, file.content]));
  const linesByFile = new Map<string, string[]>();
  const excerpts = new Map<string, SourceExcerpts["items"][number]>();
  let truncated = false;

  for (const { file, line, column, itemIndex } of locations) {
    const content = sources.get(file);
    if (content === undefined) continue;
    let lines = linesByFile.get(file);
    if (!lines) {
      lines = content.split(/\r\n|[\n\r\u2028\u2029]/);
      linesByFile.set(file, lines);
    }

    const firstLine = lines[line];
    if (firstLine === undefined || column < 0 || column > firstLine.length) continue;
    let startColumn = firstLine.length > MAX_SOURCE_EXCERPT_LENGTH ? Math.max(0, column - 24) : 0;
    if (/^[\uDC00-\uDFFF]/.test(firstLine.charAt(startColumn))) startColumn--;
    const key = JSON.stringify([file, line, startColumn]);
    const existing = excerpts.get(key);
    if (existing) {
      if (!existing.itemIndexes.includes(itemIndex)) existing.itemIndexes.push(itemIndex);
      continue;
    }
    if (excerpts.size >= limit) {
      truncated = true;
      continue;
    }

    const text = lines.slice(line, line + 3).join("\n")
      .slice(startColumn, startColumn + MAX_SOURCE_EXCERPT_LENGTH)
      .replace(/[\uD800-\uDBFF]$/, "");
    if (!text.trim()) continue;
    excerpts.set(key, {
      file,
      startLine: line + 1,
      startColumn: startColumn + 1,
      text,
      itemIndexes: [itemIndex],
    });
  }

  return { items: [...excerpts.values()], truncated };
}
