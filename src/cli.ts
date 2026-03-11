import path from "node:path";
import process from "node:process";
import {
  getProvider,
  isProviderName,
  listProviders,
  type ProviderDefinition,
  type ProviderName,
} from "./providers.ts";
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

function createDefaultOptions(): CliOptions {
  return {
    branchPrefix: "pairmind",
    help: false,
    keep: false,
    providerArgs: [],
    repo: process.cwd(),
  };
}

function isHelpFlag(arg: string): boolean {
  return arg === "-h" || arg === "--help";
}

function getRequiredValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }

  return value;
}

function consumeExplicitProvider(
  args: string[],
  index: number,
  options: CliOptions,
): number {
  const provider = getRequiredValue(args, index, "--provider");
  if (!isProviderName(provider)) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  options.provider = provider;
  return index + 2;
}

function consumeSessionOption(
  args: string[],
  index: number,
  options: CliOptions,
  flag: "--base-dir" | "--branch-prefix" | "--name" | "--repo",
): number {
  const value = getRequiredValue(args, index, flag);

  switch (flag) {
    case "--repo":
      options.repo = path.resolve(value);
      break;
    case "--base-dir":
      options.baseDir = path.resolve(value);
      break;
    case "--branch-prefix":
      options.branchPrefix = value;
      break;
    case "--name":
      options.name = value;
      break;
  }

  return index + 2;
}

function isSessionOptionFlag(
  arg: string,
): arg is "--base-dir" | "--branch-prefix" | "--name" | "--repo" {
  return arg === "--repo" || arg === "--base-dir" || arg === "--branch-prefix" || arg === "--name";
}

function handleUnknownProviderArg(
  args: string[],
  index: number,
  options: CliOptions,
): number {
  const arg = args[index];
  if (!arg || options.provider || arg.startsWith("-")) {
    options.providerArgs = args.slice(index);
    return args.length;
  }

  options.parseError = `Unknown provider: ${arg}`;
  options.providerArgs = args.slice(index + 1);
  return args.length;
}

function consumeLeadingCommand(args: string[]): void {
  if (args[0] === "run") {
    args.shift();
  }
}

function consumeLeadingProvider(args: string[], options: CliOptions): void {
  const firstArg = args.at(0);
  if (firstArg && isProviderName(firstArg)) {
    options.provider = firstArg;
    args.shift();
  }
}

function consumeArg(args: string[], index: number, options: CliOptions): number {
  const arg = args[index];
  if (!arg) {
    return index + 1;
  }

  if (arg === "--") {
    options.providerArgs = args.slice(index + 1);
    return args.length;
  }

  if (isHelpFlag(arg)) {
    options.help = true;
    return index + 1;
  }

  if (arg === "--keep") {
    options.keep = true;
    return index + 1;
  }

  if (arg === "--provider") {
    return consumeExplicitProvider(args, index, options);
  }

  if (isSessionOptionFlag(arg)) {
    return consumeSessionOption(args, index, options, arg);
  }

  if (!options.provider && isProviderName(arg)) {
    options.provider = arg;
    return index + 1;
  }

  return handleUnknownProviderArg(args, index, options);
}

export function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  const options = createDefaultOptions();

  consumeLeadingCommand(args);
  consumeLeadingProvider(args, options);

  let index = 0;
  while (index < args.length) {
    index = consumeArg(args, index, options);
  }

  return options;
}

function getProviderOrThrow(
  options: CliOptions,
  deps: CliDeps,
  output: CliOutput,
): ProviderDefinition {
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

  return provider;
}

async function createSession(
  options: CliOptions,
  deps: CliDeps,
): Promise<WorktreeSession> {
  const repoRoot = await deps.findRepoRoot(options.repo);

  return await deps.createWorktreeSession({
    repoRoot,
    branchPrefix: options.branchPrefix,
    ...(options.baseDir ? { baseDir: options.baseDir } : {}),
    ...(options.name ? { name: options.name } : {}),
  });
}

function reportSessionStart(
  output: CliOutput,
  session: WorktreeSession,
  provider: ProviderDefinition,
): void {
  output.stderr(`provider: ${provider.label}`);
  output.stderr(`worktree: ${session.worktreePath}`);
  output.stderr(`branch:   ${session.branchName}`);
}

async function cleanupAfterRun(
  options: CliOptions,
  deps: CliDeps,
  output: CliOutput,
  session: WorktreeSession,
): Promise<void> {
  if (options.keep) {
    return;
  }

  const removed = await deps.cleanupSessionIfPristine(session);
  if (!removed) {
    output.stderr("Kept worktree because it contains changes or new commits.");
  }
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

    const provider = getProviderOrThrow(options, deps, output);
    session = await createSession(options, deps);
    reportSessionStart(output, session, provider);

    const result = await deps.runProviderInWorktree(
      session,
      provider,
      options.providerArgs,
    );

    await cleanupAfterRun(options, deps, output, session);

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
