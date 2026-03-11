import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { formatHelp, main, parseArgs, runCli } from "../src/cli.ts";
import { getProvider, listProviders } from "../src/providers.ts";
import {
  cleanupSessionIfPristine,
  createWorktreeSession,
  findRepoRoot,
  resolveWorktreeParent,
  runProviderInWorktree,
  sanitizeBranchSegment,
} from "../src/session.ts";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }

  return result.stdout.trim();
}

function createRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pairmind-test-"));
  git(root, "init");
  git(root, "config", "user.name", "Pairmind");
  git(root, "config", "user.email", "pairmind@example.com");
  fs.writeFileSync(path.join(root, "README.md"), "# test\n");
  git(root, "add", "README.md");
  git(root, "commit", "-m", "init");
  return root;
}

function createOutput(): {
  io: {
    stderr: (message: string) => void;
    stdout: (message: string) => void;
  };
  stderr: string[];
  stdout: string[];
} {
  const stderr: string[] = [];
  const stdout: string[] = [];

  return {
    io: {
      stderr(message: string): void {
        stderr.push(message);
      },
      stdout(message: string): void {
        stdout.push(message);
      },
    },
    stderr,
    stdout,
  };
}

function toMessage(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

void test("sanitizeBranchSegment normalizes values", () => {
  assert.equal(sanitizeBranchSegment("Feature Branch !"), "feature-branch");
  assert.equal(sanitizeBranchSegment("///"), "session");
});

void test("formatHelp includes the supported providers", () => {
  const help = formatHelp();

  assert.match(help, /Pairmind/);
  assert.match(help, /claude Claude Code/);
  assert.match(help, /codex {2}OpenAI Codex/);
});

void test("resolveWorktreeParent defaults next to the repo", () => {
  const repoRoot = "/tmp/example/repo";
  assert.equal(
    resolveWorktreeParent(repoRoot),
    "/tmp/example/.pairmind-worktrees/repo",
  );
});

void test("resolveWorktreeParent honors an override directory", () => {
  const repoRoot = "/tmp/example/repo";
  assert.equal(
    resolveWorktreeParent(repoRoot, "/tmp/custom"),
    path.resolve("/tmp/custom"),
  );
});

void test("parseArgs reads provider and forwards trailing args", () => {
  const options = parseArgs(["claude", "--keep", "--", "--continue"]);

  assert.equal(options.provider, "claude");
  assert.equal(options.keep, true);
  assert.deepEqual(options.providerArgs, ["--continue"]);
});

void test("parseArgs supports --provider", () => {
  const options = parseArgs(["run", "--provider", "codex", "--repo", "../demo"]);

  assert.equal(options.provider, "codex");
  assert.equal(options.repo, path.resolve("../demo"));
});

void test("parseArgs handles all session option flags", () => {
  const options = parseArgs([
    "--provider",
    "codex",
    "--base-dir",
    "/tmp/pairmind",
    "--branch-prefix",
    "feature",
    "--name",
    "demo",
  ]);

  assert.equal(options.provider, "codex");
  assert.equal(options.baseDir, path.resolve("/tmp/pairmind"));
  assert.equal(options.branchPrefix, "feature");
  assert.equal(options.name, "demo");
});

void test("parseArgs accepts a provider after leading flags", () => {
  const options = parseArgs(["--keep", "claude"]);

  assert.equal(options.keep, true);
  assert.equal(options.provider, "claude");
});

void test("parseArgs forwards unknown flag-shaped arguments to the provider", () => {
  const options = parseArgs(["codex", "--model", "gpt-5-codex"]);

  assert.equal(options.provider, "codex");
  assert.deepEqual(options.providerArgs, ["--model", "gpt-5-codex"]);
});

void test("parseArgs reports unknown providers before Git work starts", () => {
  const options = parseArgs(["cursor", "--foo"]);

  assert.equal(options.parseError, "Unknown provider: cursor");
});

void test("parseArgs supports the help flag", () => {
  const options = parseArgs(["--help"]);

  assert.equal(options.help, true);
});

void test("parseArgs rejects --provider without a value", () => {
  assert.throws(() => parseArgs(["--provider"]), /Missing value for --provider/);
});

void test("parseArgs rejects unknown values passed to --provider", () => {
  assert.throws(() => parseArgs(["--provider", "cursor"]), /Unknown provider: cursor/);
});

void test("parseArgs rejects flags missing required values", () => {
  assert.throws(() => parseArgs(["codex", "--repo"]), /Missing value for --repo/);
});

void test("listProviders returns all supported providers", () => {
  const providers = listProviders().map((provider) => provider.name);

  assert.deepEqual(providers, ["claude", "codex"]);
});

void test("getProvider returns undefined for unsupported providers", () => {
  assert.equal(getProvider("cursor"), undefined);
});

void test("runCli returns help without touching Git", async () => {
  const output = createOutput();
  const result = await runCli(["--help"], undefined, output.io);

  assert.deepEqual(result, { code: 0, kind: "exit" });
  assert.equal(output.stderr.length, 0);
  assert.equal(output.stdout.length, 1);
  assert.match(output.stdout[0] ?? "", /Pairmind/);
});

void test("runCli errors when the provider is missing", async () => {
  const output = createOutput();
  const result = await runCli([], undefined, output.io);

  assert.deepEqual(result, { code: 1, kind: "exit" });
  assert.equal(output.stdout.length, 1);
  assert.match(output.stderr[0] ?? "", /Missing provider/);
});

void test("runCli returns a parse error without printing help", async () => {
  const output = createOutput();
  const result = await runCli(["cursor"], undefined, output.io);

  assert.deepEqual(result, { code: 1, kind: "exit" });
  assert.equal(output.stdout.length, 0);
  assert.match(output.stderr[0] ?? "", /Unknown provider: cursor/);
});

void test("runCli returns a signal result when the provider exits via signal", async () => {
  const output = createOutput();
  const result = await runCli(
    ["codex"],
    {
      cleanupSessionIfPristine: async () => true,
      createWorktreeSession: () => Promise.resolve({
        baseBranch: "main",
        baseCommit: "abc",
        branchName: "pairmind/main/demo",
        repoRoot: "/repo",
        sessionName: "demo",
        worktreeParent: "/tmp/wt",
        worktreePath: "/tmp/wt/demo",
      }),
      findRepoRoot: () => Promise.resolve("/repo"),
      getProvider,
      listProviders,
      runProviderInWorktree: () => Promise.resolve({
        code: null,
        signal: "SIGINT",
      }),
    },
    output.io,
  );

  assert.deepEqual(result, { kind: "signal", signal: "SIGINT" });
  assert.equal(output.stderr.length, 3);
});

void test("runCli keeps non-pristine sessions and reports it", async () => {
  const output = createOutput();
  const result = await runCli(
    ["codex"],
    {
      cleanupSessionIfPristine: async () => false,
      createWorktreeSession: () => Promise.resolve({
        baseBranch: "main",
        baseCommit: "abc",
        branchName: "pairmind/main/demo",
        repoRoot: "/repo",
        sessionName: "demo",
        worktreeParent: "/tmp/wt",
        worktreePath: "/tmp/wt/demo",
      }),
      findRepoRoot: () => Promise.resolve("/repo"),
      getProvider,
      listProviders,
      runProviderInWorktree: () => Promise.resolve({
        code: 0,
        signal: null,
      }),
    },
    output.io,
  );

  assert.deepEqual(result, { code: 0, kind: "exit" });
  assert.match(output.stderr.at(-1) ?? "", /Kept worktree/);
});

void test("runCli cleans up and reports provider lookup failures", async () => {
  const output = createOutput();
  let cleanedUp = false;

  const result = await runCli(
    ["codex"],
    {
      cleanupSessionIfPristine: async () => {
        cleanedUp = true;
        return true;
      },
      createWorktreeSession: () => Promise.resolve({
        baseBranch: "main",
        baseCommit: "abc",
        branchName: "pairmind/main/demo",
        repoRoot: "/repo",
        sessionName: "demo",
        worktreeParent: "/tmp/wt",
        worktreePath: "/tmp/wt/demo",
      }),
      findRepoRoot: () => Promise.resolve("/repo"),
      getProvider: () => undefined,
      listProviders,
      runProviderInWorktree: () => Promise.resolve({
        code: 0,
        signal: null,
      }),
    },
    output.io,
  );

  assert.deepEqual(result, { code: 1, kind: "exit" });
  assert.equal(cleanedUp, false);
  assert.match(output.stderr[0] ?? "", /Unknown provider/);
});

void test("runCli attempts cleanup when a launched session fails", async () => {
  const output = createOutput();
  let cleanedUp = false;

  const result = await runCli(
    ["codex"],
    {
      cleanupSessionIfPristine: async () => {
        cleanedUp = true;
        return true;
      },
      createWorktreeSession: () => Promise.resolve({
        baseBranch: "main",
        baseCommit: "abc",
        branchName: "pairmind/main/demo",
        repoRoot: "/repo",
        sessionName: "demo",
        worktreeParent: "/tmp/wt",
        worktreePath: "/tmp/wt/demo",
      }),
      findRepoRoot: () => Promise.resolve("/repo"),
      getProvider,
      listProviders,
      runProviderInWorktree: async () => {
        throw new Error("launch failed");
      },
    },
    output.io,
  );

  assert.deepEqual(result, { code: 1, kind: "exit" });
  assert.equal(cleanedUp, true);
  assert.match(output.stderr.at(-1) ?? "", /launch failed/);
});

void test("main exits with the returned exit code", async () => {
  let exitCode = -1;

  await main(["--help"], {
    exit(code: number): never {
      exitCode = code;
      throw new Error("exit");
    },
    kill(_pid: number, _signal: NodeJS.Signals): void {
      return undefined;
    },
    pid: 123,
    stderr(_message: string): void {
      return undefined;
    },
    stdout(_message: string): void {
      return undefined;
    },
  }).catch((error: unknown) => {
    assert.match(String(error), /exit/);
  });

  assert.equal(exitCode, 0);
});

void test("main uses the default runtime stdout and exit path", async () => {
  const logMessages: string[] = [];
  const originalExit = process.exit.bind(process);
  const originalLog = console.log.bind(console);

  process.exit = ((code?: number) => {
    throw new Error(`exit:${String(code ?? 0)}`);
  }) as typeof process.exit;
  console.log = (message?: unknown): void => {
    logMessages.push(toMessage(message ?? ""));
  };

  try {
    await main(["--help"]);
    assert.fail("main should have exited");
  } catch (error) {
    assert.match(String(error), /exit:0/);
  } finally {
    process.exit = originalExit;
    console.log = originalLog;
  }

  assert.match(logMessages[0] ?? "", /Pairmind/);
});

void test("main uses the default runtime stderr path on failure", async () => {
  const errorMessages: string[] = [];
  const originalError = console.error.bind(console);
  const originalExit = process.exit.bind(process);

  process.exit = ((code?: number) => {
    throw new Error(`exit:${String(code ?? 0)}`);
  }) as typeof process.exit;
  console.error = (message?: unknown): void => {
    errorMessages.push(toMessage(message ?? ""));
  };

  try {
    await main(["cursor"]);
    assert.fail("main should have exited");
  } catch (error) {
    assert.match(String(error), /exit:1/);
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }

  assert.match(errorMessages[0] ?? "", /Unknown provider: cursor/);
});

void test("main uses the default runtime kill path when the provider exits by signal", async () => {
  const repoRoot = createRepo();
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "pairmind-default-signal-bin-"));
  const fakeBinaryPath = path.join(fakeBinDir, "codex");
  const originalKill = process.kill.bind(process);
  const originalExit = process.exit.bind(process);
  const previousPath = process.env["PATH"];
  let killedSignal: NodeJS.Signals | undefined;

  fs.writeFileSync(
    fakeBinaryPath,
    "#!/bin/sh\nkill -INT $$\n",
    { mode: 0o755 },
  );

  process.exit = ((code?: number) => {
    throw new Error(`exit:${String(code ?? 0)}`);
  }) as typeof process.exit;
  process.kill = ((_pid: number, signal: NodeJS.Signals) => {
    killedSignal = signal;
    return true;
  }) as typeof process.kill;
  process.env["PATH"] = `${fakeBinDir}:${previousPath ?? ""}`;

  try {
    await main(["codex", "--repo", repoRoot]);
  } finally {
    process.kill = originalKill;
    process.exit = originalExit;
    process.env["PATH"] = previousPath;
  }

  assert.equal(killedSignal, "SIGINT");
});

void test("main uses the runtime kill path when the provider exits by signal", async () => {
  const repoRoot = createRepo();
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "pairmind-signal-bin-"));
  const fakeBinaryPath = path.join(fakeBinDir, "codex");
  const previousPath = process.env["PATH"];
  let killedSignal: NodeJS.Signals | undefined;

  fs.writeFileSync(
    fakeBinaryPath,
    "#!/bin/sh\nkill -INT $$\n",
    { mode: 0o755 },
  );

  process.env["PATH"] = `${fakeBinDir}:${previousPath ?? ""}`;

  try {
    await main(["codex", "--repo", repoRoot], {
      exit(): never {
        throw new Error("exit should not be called");
      },
      kill(_pid: number, signal: NodeJS.Signals): void {
        killedSignal = signal;
      },
      pid: 123,
      stderr(_message: string): void {
        return undefined;
      },
      stdout(_message: string): void {
        return undefined;
      },
    });
  } finally {
    process.env["PATH"] = previousPath;
  }

  assert.equal(killedSignal, "SIGINT");
});

void test("createWorktreeSession and cleanupSessionIfPristine remove untouched worktrees", async () => {
  const repoRoot = createRepo();
  const session = await createWorktreeSession({ repoRoot });

  assert.equal(fs.existsSync(session.worktreePath), true);
  const removed = await cleanupSessionIfPristine(session);

  assert.equal(removed, true);
  assert.equal(fs.existsSync(session.worktreePath), false);
});

void test("cleanupSessionIfPristine keeps dirty worktrees", async () => {
  const repoRoot = createRepo();
  const session = await createWorktreeSession({ repoRoot });
  fs.writeFileSync(path.join(session.worktreePath, "notes.txt"), "keep\n");

  const removed = await cleanupSessionIfPristine(session);

  assert.equal(removed, false);
  assert.equal(fs.existsSync(session.worktreePath), true);
});

void test("findRepoRoot resolves the current working directory by default", async () => {
  const repoRoot = createRepo();
  const previousCwd = process.cwd();
  process.chdir(repoRoot);

  try {
    assert.equal(fs.realpathSync(await findRepoRoot()), fs.realpathSync(repoRoot));
  } finally {
    process.chdir(previousCwd);
  }
});

void test("findRepoRoot rejects outside a git repository", async () => {
  const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), "pairmind-nonrepo-"));

  await assert.rejects(async () => {
    await findRepoRoot(nonRepo);
  });
});

void test("cleanupSessionIfPristine keeps clean worktrees with new commits", async () => {
  const repoRoot = createRepo();
  const session = await createWorktreeSession({ repoRoot });

  fs.writeFileSync(path.join(session.worktreePath, "notes.txt"), "commit me\n");
  git(session.worktreePath, "add", "notes.txt");
  git(session.worktreePath, "commit", "-m", "work");

  const removed = await cleanupSessionIfPristine(session);

  assert.equal(removed, false);
  assert.equal(fs.existsSync(session.worktreePath), true);
});

void test("runProviderInWorktree launches the requested binary inside the session", async () => {
  const repoRoot = createRepo();
  const session = await createWorktreeSession({ repoRoot, name: "runner-check" });
  const provider = getProvider("codex");
  assert.ok(provider);

  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "pairmind-bin-"));
  const fakeBinaryPath = path.join(fakeBinDir, "codex");
  const outputPath = path.join(fakeBinDir, "spawn.json");

  fs.writeFileSync(
    fakeBinaryPath,
    `#!/bin/sh
printf '{"cwd":"%s","provider":"%s","branch":"%s","args":"%s"}\n' "$PWD" "$PAIRMIND_PROVIDER" "$PAIRMIND_WORKTREE_BRANCH" "$*" > "${outputPath}"
exit 0
`,
    { mode: 0o755 },
  );

  const previousPath = process.env["PATH"];
  process.env["PATH"] = `${fakeBinDir}:${previousPath ?? ""}`;

  try {
    const result = await runProviderInWorktree(session, provider, ["--help"]);
    assert.equal(result.code, 0);

    const payload = JSON.parse(fs.readFileSync(outputPath, "utf8")) as {
      args: string;
      branch: string;
      cwd: string;
      provider: string;
    };

    assert.equal(fs.realpathSync(payload.cwd), fs.realpathSync(session.worktreePath));
    assert.equal(payload.provider, "codex");
    assert.equal(payload.branch, session.branchName);
    assert.equal(payload.args, "--help");
  } finally {
    process.env["PATH"] = previousPath;
    await cleanupSessionIfPristine(session);
  }
});

void test("runProviderInWorktree rejects when the provider binary is missing", async () => {
  const repoRoot = createRepo();
  const session = await createWorktreeSession({ repoRoot, name: "missing-binary" });
  const previousPath = process.env["PATH"];
  process.env["PATH"] = fs.mkdtempSync(path.join(os.tmpdir(), "pairmind-empty-bin-"));

  try {
    await assert.rejects(async () => {
      const baseProvider = getProvider("codex");
      assert.ok(baseProvider);

      const provider = {
        ...baseProvider,
        binary: "missing-provider",
      };
      await runProviderInWorktree(session, provider);
    });
  } finally {
    process.env["PATH"] = previousPath;
    await cleanupSessionIfPristine(session);
  }
});
