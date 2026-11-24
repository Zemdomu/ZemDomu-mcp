import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { assertWorkspaceRelative, isContainedPath } from "../src/path-policy.js";

test("POSIX containment rejects siblings and prefix collisions", () => {
  assert.equal(isContainedPath("/work/app", "/work/app/src/Page.tsx", path.posix), true);
  assert.equal(isContainedPath("/work/app", "/work/app-evil/Page.tsx", path.posix), false);
  assert.equal(isContainedPath("/work/app", "/work/secret.tsx", path.posix), false);
});

test("Windows containment is case-insensitive and rejects other drives", () => {
  assert.equal(
    isContainedPath("C:\\Work\\App", "c:\\work\\app\\src\\Page.tsx", path.win32),
    true
  );
  assert.equal(
    isContainedPath("C:\\Work\\App", "C:\\Work\\App-Evil\\Page.tsx", path.win32),
    false
  );
  assert.equal(
    isContainedPath("C:\\Work\\App", "D:\\Work\\App\\Page.tsx", path.win32),
    false
  );
});

test("entry paths reject traversal and both absolute path dialects", () => {
  assert.doesNotThrow(() => assertWorkspaceRelative("src/Page.tsx"));
  assert.throws(() => assertWorkspaceRelative("../outside.tsx"), /escapes/);
  assert.throws(() => assertWorkspaceRelative("/etc/passwd"), /workspace-relative/);
  assert.throws(() => assertWorkspaceRelative("C:\\outside.tsx"), /workspace-relative/);
  assert.throws(() => assertWorkspaceRelative("C:outside.tsx"), /workspace-relative/);
});
