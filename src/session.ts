import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ProviderDefinition } from "./providers.ts";

export interface WorktreeSession {
  baseBranch: string;
  baseCommit: string;
  branchName: string;
  repoRoot: string;
  sessionName: string;
  worktreeParent: string;
  worktreePath: string;
}

interface CreateWorktreeSessionOptions {
  baseDir?: string;
  branchPrefix?: string;
  name?: string;
  repoRoot: string;
}

interface CommandResult {
  stderr: string;
  stdout: string;
}

interface LaunchResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

async function run(
  command: string,
  args: string[],
  options: Parameters<typeof spawn>[2] = {},
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
        return;
      }

      const error = new Error(
        stderr.trim() || `Command failed: ${command} ${args.join(" ")}`,
      ) as Error & {
        code?: number | null;
        stderr?: string;
        stdout?: string;
      };
      error.code = code;
      error.stdout = stdout.trim();
      error.stderr = stderr.trim();
      reject(error);
    });
  });
}

async function git(cwd: string, ...args: string[]): Promise<CommandResult> {
  return await run("git", args, { cwd });
}

export function sanitizeBranchSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._/-]+/g, "-")
      .replace(/\/+/g, "/")
      .replace(/^-+|-+$/g, "")
      .replace(/^\/+|\/+$/g, "") || "session"
  );
}

export function buildSessionName(prefix = "pairmind"): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const host = sanitizeBranchSegment(os.hostname().split(".")[0] ?? "host");
  return `${prefix}-${stamp}-${String(process.pid)}-${host}`;
}

export function resolveWorktreeParent(
  repoRoot: string,
  overrideDir?: string,
): string {
  if (overrideDir) {
    return path.resolve(overrideDir);
  }

  const repoName = path.basename(repoRoot);
  return path.join(path.dirname(repoRoot), ".pairmind-worktrees", repoName);
}

export async function findRepoRoot(startDir = process.cwd()): Promise<string> {
  const { stdout } = await git(startDir, "rev-parse", "--show-toplevel");
  return stdout;
}

export async function getHeadRef(repoRoot: string): Promise<string> {
  const { stdout } = await git(repoRoot, "rev-parse", "HEAD");
  return stdout;
}

export async function getCurrentBranch(repoRoot: string): Promise<string> {
  const { stdout } = await git(repoRoot, "branch", "--show-current");
  return stdout || "detached";
}

export async function createWorktreeSession({
  repoRoot,
  baseDir,
  branchPrefix = "pairmind",
  name,
}: CreateWorktreeSessionOptions): Promise<WorktreeSession> {
  const baseBranch = sanitizeBranchSegment(await getCurrentBranch(repoRoot));
  const baseCommit = await getHeadRef(repoRoot);
  const sessionName = sanitizeBranchSegment(
    name ?? buildSessionName(branchPrefix),
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
    worktreeParent,
    worktreePath,
  };
}

export async function getWorktreeStatus(
  worktreePath: string,
): Promise<{ clean: boolean; head: string; status: string }> {
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

export async function removeWorktreeSession(
  session: Pick<WorktreeSession, "branchName" | "repoRoot" | "worktreePath">,
): Promise<void> {
  await git(session.repoRoot, "worktree", "remove", session.worktreePath);
  await git(session.repoRoot, "branch", "-D", session.branchName);
}

export async function cleanupSessionIfPristine(
  session: WorktreeSession,
): Promise<boolean> {
  const status = await getWorktreeStatus(session.worktreePath);
  const unchanged = status.clean && status.head === session.baseCommit;

  if (!unchanged) {
    return false;
  }

  await removeWorktreeSession(session);
  return true;
}

export async function runProviderInWorktree(
  session: WorktreeSession,
  provider: ProviderDefinition,
  providerArgs: string[] = [],
): Promise<LaunchResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(provider.binary, providerArgs, {
      cwd: session.worktreePath,
      stdio: "inherit",
      env: {
        ...process.env,
        PAIRMIND_PRIMARY_REPO_ROOT: session.repoRoot,
        PAIRMIND_PROVIDER: provider.name,
        PAIRMIND_WORKTREE_BRANCH: session.branchName,
        PAIRMIND_WORKTREE_PATH: session.worktreePath,
      },
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
}
