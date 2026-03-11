import path from "node:path";
import process from "node:process";
import { getProvider, isProviderName, listProviders, type ProviderName } from "./providers.ts";
import {
  cleanupSessionIfPristine,
  createWorktreeSession,
  findRepoRoot,
  runProviderInWorktree,
  type WorktreeSession,
} from "./session.ts";

interface CliOutput {
  stderr: (message: string) => void;
  stdout: (message: string) => void;
}

interface CliRuntime extends CliOutput {
  exit: (code: number) => never;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  pid: number;
}

interface CliDeps {
  cleanupSessionIfPristine: typeof cleanupSessionIfPristine;
  createWorktreeSession: typeof createWorktreeSession;
  findRepoRoot: typeof findRepoRoot;
  getProvider: typeof getProvider;
  listProviders: typeof listProviders;
  runProviderInWorktree: typeof runProviderInWorktree;
}

type CliResult =
  | {
      code: number;
      kind: "exit";
    }
  | {
      kind: "signal";
      signal: NodeJS.Signals;
    };

export interface CliOptions {
  baseDir?: string;
  branchPrefix: string;
  help: boolean;
  keep: boolean;
  name?: string;
  parseError?: string;
  provider?: ProviderName;
  providerArgs: string[];
  repo: string;
}

const defaultDeps: CliDeps = {
  cleanupSessionIfPristine,
  createWorktreeSession,
  findRepoRoot,
  getProvider,
  listProviders,
  runProviderInWorktree,
};

const defaultRuntime: CliRuntime = {
  exit(code: number): never {
    process.exit(code);
  },
  kill(pid: number, signal: NodeJS.Signals): void {
    process.kill(pid, signal);
  },
  pid: process.pid,
  stderr(message: string): void {
    console.error(message);
  },
  stdout(message: string): void {
    console.log(message);
  },
};

export function formatHelp(providers = listProviders()): string {
  const providerLines = providers
    .map((provider) => `  ${provider.name.padEnd(6)} ${provider.label}`)
    .join("\n");

  return `Pairmind

Start an AI co-creation session in a fresh git worktree.

Usage:
  pairmind <provider> [options] [-- <provider args...>]
  pairmind run <provider> [options] [-- <provider args...>]

Providers:
${providerLines}

Options:
  --repo <path>         Git repository root or any path inside it
  --base-dir <path>     Parent directory that will contain worktrees
  --branch-prefix <x>   Prefix for generated branches (default: pairmind)
  --name <x>            Override the generated session name
  --provider <name>     Explicit provider (codex or claude)
  --keep                Keep the worktree even if nothing changed
  -h, --help            Show this help

Examples:
  pairmind codex
  pairmind claude -- --continue
  pairmind run codex --repo ~/dev/api -- --model gpt-5-codex
`;
}

export function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  const options: CliOptions = {
    branchPrefix: "pairmind",
    help: false,
    keep: false,
    providerArgs: [],
    repo: process.cwd(),
  };

  if (args[0] === "run") {
    args.shift();
  }

  const firstArg = args.at(0);
  if (firstArg && isProviderName(firstArg)) {
    options.provider = firstArg;
    args.shift();
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }

    if (arg === "--") {
      options.providerArgs = args.slice(index + 1);
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

    if (arg === "--provider") {
      const next = args[index + 1];
      if (!next) {
        throw new Error("Missing value for --provider");
      }

      if (!isProviderName(next)) {
        throw new Error(`Unknown provider: ${next}`);
      }

      options.provider = next;
      index += 1;
      continue;
    }

    if (arg === "--repo" || arg === "--base-dir" || arg === "--branch-prefix" || arg === "--name") {
      const next = args[index + 1];
      if (!next) {
        throw new Error(`Missing value for ${arg}`);
      }

      switch (arg) {
        case "--repo":
          options.repo = path.resolve(next);
          break;
        case "--base-dir":
          options.baseDir = path.resolve(next);
          break;
        case "--branch-prefix":
          options.branchPrefix = next;
          break;
        case "--name":
          options.name = next;
          break;
      }

      index += 1;
      continue;
    }

    if (!options.provider && isProviderName(arg)) {
      options.provider = arg;
      continue;
    }

    if (!options.provider && !arg.startsWith("-")) {
      options.parseError = `Unknown provider: ${arg}`;
      options.providerArgs = args.slice(index + 1);
      break;
    }

    options.providerArgs = args.slice(index);
    break;
  }

  return options;
}

export async function runCli(
  argv: string[],
  deps: CliDeps = defaultDeps,
  output: CliOutput = defaultRuntime,
): Promise<CliResult> {
  let session: WorktreeSession | undefined;

  try {
    const options = parseArgs(argv);

    if (options.help) {
      output.stdout(formatHelp(deps.listProviders()));
      return { code: 0, kind: "exit" };
    }

    if (options.parseError) {
      throw new Error(options.parseError);
    }

    if (!options.provider) {
      output.stdout(formatHelp(deps.listProviders()));
      throw new Error("Missing provider. Use 'codex' or 'claude'.");
    }

    const provider = deps.getProvider(options.provider);
    if (!provider) {
      throw new Error(`Unknown provider: ${options.provider}`);
    }

    const repoRoot = await deps.findRepoRoot(options.repo);
    const sessionOptions = {
      repoRoot,
      branchPrefix: options.branchPrefix,
      ...(options.baseDir ? { baseDir: options.baseDir } : {}),
      ...(options.name ? { name: options.name } : {}),
    };
    session = await deps.createWorktreeSession(sessionOptions);

    output.stderr(`provider: ${provider.label}`);
    output.stderr(`worktree: ${session.worktreePath}`);
    output.stderr(`branch:   ${session.branchName}`);

    const result = await deps.runProviderInWorktree(
      session,
      provider,
      options.providerArgs,
    );

    if (!options.keep) {
      const removed = await deps.cleanupSessionIfPristine(session);
      if (!removed) {
        output.stderr("Kept worktree because it contains changes or new commits.");
      }
    }

    if (result.signal) {
      return { kind: "signal", signal: result.signal };
    }

    return { code: result.code ?? 0, kind: "exit" };
  } catch (error) {
    if (session) {
      try {
        await deps.cleanupSessionIfPristine(session);
      } catch {
        // Ignore cleanup failures and surface the original error.
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    output.stderr(`pairmind: ${message}`);
    return { code: 1, kind: "exit" };
  }
}

export async function main(argv: string[], runtime: CliRuntime = defaultRuntime): Promise<void> {
  const result = await runCli(argv, defaultDeps, runtime);

  if (result.kind === "signal") {
    runtime.kill(runtime.pid, result.signal);
    return;
  }

  runtime.exit(result.code);
}
