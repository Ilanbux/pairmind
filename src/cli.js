import path from "node:path";
import process from "node:process";
import {
  cleanupSessionIfPristine,
  createWorktreeSession,
  findRepoRoot,
  runCodexInWorktree,
} from "./lib.js";

function printHelp() {
  console.log(`codex-wt

Launch Codex inside a fresh git worktree.

Usage:
  codex-wt [options] [-- <codex args...>]
  codex-wt run [options] [-- <codex args...>]

Options:
  --repo <path>         Git repository root or any path inside it
  --base-dir <path>     Parent directory that will contain worktrees
  --branch-prefix <x>   Prefix for generated branches (default: codex)
  --name <x>            Override the generated session name
  --keep                Keep the worktree even if nothing changed
  -h, --help            Show this help
`);
}

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    branchPrefix: "codex",
    codexArgs: [],
    keep: false,
    repo: process.cwd(),
  };

  if (args[0] === "run") {
    args.shift();
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--") {
      options.codexArgs = args.slice(index + 1);
      break;
    }

    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }

    if (arg === "--keep") {
      options.keep = true;
      continue;
    }

    if (arg === "--repo" || arg === "--base-dir" || arg === "--branch-prefix" || arg === "--name") {
      const next = args[index + 1];
      if (!next) {
        throw new Error(`Missing value for ${arg}`);
      }

      if (arg === "--repo") {
        options.repo = path.resolve(next);
      } else if (arg === "--base-dir") {
        options.baseDir = path.resolve(next);
      } else if (arg === "--branch-prefix") {
        options.branchPrefix = next;
      } else if (arg === "--name") {
        options.name = next;
      }

      index += 1;
      continue;
    }

    options.codexArgs = args.slice(index);
    break;
  }

  return options;
}

export async function main(argv) {
  let session;

  try {
    const options = parseArgs(argv);

    if (options.help) {
      printHelp();
      return;
    }

    const repoRoot = await findRepoRoot(options.repo);
    session = await createWorktreeSession({
      repoRoot,
      baseDir: options.baseDir,
      branchPrefix: options.branchPrefix,
      name: options.name,
    });

    console.error(`worktree: ${session.worktreePath}`);
    console.error(`branch:   ${session.branchName}`);

    const result = await runCodexInWorktree(session, options.codexArgs);

    if (!options.keep) {
      const removed = await cleanupSessionIfPristine(session);
      if (!removed) {
        console.error("Kept worktree because it contains changes or new commits.");
      }
    }

    if (result.signal) {
      process.kill(process.pid, result.signal);
      return;
    }

    process.exit(result.code ?? 0);
  } catch (error) {
    if (session) {
      try {
        await cleanupSessionIfPristine(session);
      } catch {
        // Ignore cleanup failures and surface the original error.
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error(`codex-wt: ${message}`);
    process.exit(1);
  }
}
