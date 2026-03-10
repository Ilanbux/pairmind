import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
        return;
      }

      const error = new Error(
        stderr.trim() || `Command failed: ${command} ${args.join(" ")}`,
      );
      error.code = code;
      error.stdout = stdout.trim();
      error.stderr = stderr.trim();
      reject(error);
    });
  });
}

export function sanitizeBranchSegment(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^-+|-+$/g, "")
    .replace(/^\/+|\/+$/g, "") || "session";
}

export function buildSessionName(prefix = "codex") {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const host = sanitizeBranchSegment(os.hostname().split(".")[0] || "host");
  return `${prefix}-${stamp}-${process.pid}-${host}`;
}

export function resolveWorktreeParent(repoRoot, overrideDir) {
  if (overrideDir) {
    return path.resolve(overrideDir);
  }

  const repoName = path.basename(repoRoot);
  return path.join(path.dirname(repoRoot), ".codex-worktrees", repoName);
}

async function git(cwd, ...args) {
  return run("git", args, { cwd });
}

export async function findRepoRoot(startDir = process.cwd()) {
  const { stdout } = await git(startDir, "rev-parse", "--show-toplevel");
  return stdout;
}

export async function getHeadRef(repoRoot) {
  const { stdout } = await git(repoRoot, "rev-parse", "HEAD");
  return stdout;
}

export async function getCurrentBranch(repoRoot) {
  const { stdout } = await git(repoRoot, "branch", "--show-current");
  return stdout || "detached";
}

export async function createWorktreeSession({
  repoRoot,
  baseDir,
  branchPrefix = "codex",
  name,
}) {
  const baseBranch = sanitizeBranchSegment(await getCurrentBranch(repoRoot));
  const baseCommit = await getHeadRef(repoRoot);
  const sessionName = sanitizeBranchSegment(
    name || buildSessionName(branchPrefix),
  );
  const branchName = `${sanitizeBranchSegment(branchPrefix)}/${baseBranch}/${sessionName}`;
  const worktreeParent = resolveWorktreeParent(repoRoot, baseDir);
  const worktreePath = path.join(worktreeParent, sessionName);

  fs.mkdirSync(worktreeParent, { recursive: true });
  await git(repoRoot, "worktree", "add", "-b", branchName, worktreePath, baseCommit);

  return {
    baseBranch,
    baseCommit,
    branchName,
    repoRoot,
    sessionName,
    worktreePath,
    worktreeParent,
  };
}

export async function getWorktreeStatus(worktreePath) {
  const [{ stdout: status }, { stdout: head }] = await Promise.all([
    git(worktreePath, "status", "--porcelain"),
    git(worktreePath, "rev-parse", "HEAD"),
  ]);

  return {
    clean: status.length === 0,
    head,
    status,
  };
}

export async function removeWorktreeSession({ repoRoot, worktreePath, branchName }) {
  await git(repoRoot, "worktree", "remove", worktreePath);
  await git(repoRoot, "branch", "-D", branchName);
}

export async function cleanupSessionIfPristine(session) {
  const status = await getWorktreeStatus(session.worktreePath);
  const unchanged = status.clean && status.head === session.baseCommit;

  if (!unchanged) {
    return false;
  }

  await removeWorktreeSession(session);
  return true;
}

export async function runCodexInWorktree(session, codexArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", codexArgs, {
      cwd: session.worktreePath,
      stdio: "inherit",
      env: {
        ...process.env,
        CODEX_PRIMARY_REPO_ROOT: session.repoRoot,
        CODEX_WORKTREE_BRANCH: session.branchName,
        CODEX_WORKTREE_PATH: session.worktreePath,
      },
    });

    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
}
