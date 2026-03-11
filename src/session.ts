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

const INTERNAL_WORKTREE_DIR = ".pairmind-worktrees";

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

async function getGitPath(repoRoot: string, gitPath: string): Promise<string> {
  const { stdout } = await git(repoRoot, "rev-parse", "--git-path", gitPath);
  return path.resolve(repoRoot, stdout);
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

async function ensureWorktreeDirExcluded(repoRoot: string): Promise<void> {
  const excludePath = await getGitPath(repoRoot, "info/exclude");
  const entry = `${INTERNAL_WORKTREE_DIR}/`;
  const contents = fs.existsSync(excludePath)
    ? fs.readFileSync(excludePath, "utf8")
    : "";
  const lines = contents.split(/\r?\n/).map((line) => line.trim());

  if (lines.includes(entry)) {
    return;
  }

  const prefix = contents.length > 0 ? ensureTrailingNewline(contents) : "";
  fs.writeFileSync(excludePath, `${prefix}${entry}\n`);
}

function isAllowedBranchChar(char: string): boolean {
  return /[a-z0-9._-]/.test(char);
}

function trimBoundaryChars(value: string): string {
  let start = 0;
  let end = value.length;

  while (start < end && (value[start] === "-" || value[start] === "/")) {
    start += 1;
  }

  while (end > start && (value[end - 1] === "-" || value[end - 1] === "/")) {
    end -= 1;
  }

  return value.slice(start, end);
}

export function sanitizeBranchSegment(value: string): string {
  let normalized = "";

  for (const rawChar of value.toLowerCase()) {
    if (rawChar === "/") {
      if (!normalized.endsWith("/")) {
        normalized += rawChar;
      }
      continue;
    }

    if (isAllowedBranchChar(rawChar)) {
      normalized += rawChar;
      continue;
    }

    if (!normalized.endsWith("-")) {
      normalized += "-";
    }
  }

  const trimmed = trimBoundaryChars(normalized);

  return trimmed || "session";
}

export function buildSessionName(prefix = "pairmind"): string {
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
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

  return path.join(repoRoot, INTERNAL_WORKTREE_DIR);
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

  if (!baseDir) {
    await ensureWorktreeDirExcluded(repoRoot);
  }

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
