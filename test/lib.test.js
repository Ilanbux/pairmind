import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cleanupSessionIfPristine,
  createWorktreeSession,
  resolveWorktreeParent,
  sanitizeBranchSegment,
} from "../src/lib.js";

function git(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }

  return result.stdout.trim();
}

function createRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-wt-test-"));
  git(root, "init");
  git(root, "config", "user.name", "Codex WT");
  git(root, "config", "user.email", "codex@example.com");
  fs.writeFileSync(path.join(root, "README.md"), "# test\n");
  git(root, "add", "README.md");
  git(root, "commit", "-m", "init");
  return root;
}

test("sanitizeBranchSegment normalizes values", () => {
  assert.equal(sanitizeBranchSegment("Feature Branch !"), "feature-branch");
  assert.equal(sanitizeBranchSegment("///"), "session");
});

test("resolveWorktreeParent defaults next to the repo", () => {
  const repoRoot = "/tmp/example/repo";
  assert.equal(
    resolveWorktreeParent(repoRoot),
    "/tmp/example/.codex-worktrees/repo",
  );
});

test("createWorktreeSession and cleanupSessionIfPristine remove untouched worktrees", async () => {
  const repoRoot = createRepo();
  const session = await createWorktreeSession({ repoRoot });

  assert.equal(fs.existsSync(session.worktreePath), true);
  const removed = await cleanupSessionIfPristine(session);

  assert.equal(removed, true);
  assert.equal(fs.existsSync(session.worktreePath), false);
});

test("cleanupSessionIfPristine keeps dirty worktrees", async () => {
  const repoRoot = createRepo();
  const session = await createWorktreeSession({ repoRoot });
  fs.writeFileSync(path.join(session.worktreePath, "notes.txt"), "keep\n");

  const removed = await cleanupSessionIfPristine(session);

  assert.equal(removed, false);
  assert.equal(fs.existsSync(session.worktreePath), true);
});
