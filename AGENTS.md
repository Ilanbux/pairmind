# AGENTS.md

> Single source of truth for any agent working in this repo.
> Keep this file short, concrete, and up to date.

## Agent posture

You are working on an early greenfield CLI with a single human decision-maker. Prefer clean structure over short-term patches, but keep changes proportional to the product stage. Act autonomously on small, well-understood tasks. Surface product or architecture trade-offs before making structural changes, especially around naming, UX, session lifecycle, or provider support.

## Project

- **Name:** `pairmind`
- **One-liner:** CLI for AI-assisted co-creation sessions that launch coding agents inside isolated Git worktrees.
- **Stage:** MVP
- **Audience:** solo developers and small teams using local AI coding CLIs such as Codex and Claude Code

### Domain

- Problem solved: start isolated AI coding sessions from any Git repo so experimentation stays cheap, reversible, and safe.
- Critical user flows:
  - launch `pairmind codex` or `pairmind claude` from a Git repo
  - create a fresh worktree and branch for the session
  - forward provider-specific CLI args after `--`
  - auto-delete untouched sessions
  - preserve sessions that contain edits or new commits
- Domain constraints:
  - local-first workflow
  - must operate directly on real Git repos and worktrees
  - must not lose user work
  - should stay provider-agnostic at the session layer
- Most expensive regressions:
  - deleting a worktree that contains work
  - leaving Git state inconsistent
  - coupling the core flow to one provider

### Priorities (ranked)

1. safety of user work
2. clarity of CLI behavior
3. provider-agnostic architecture
4. maintainability of core Git/session logic

## Stack

### Core

- Language(s): TypeScript
- Runtime(s): Bun
- Framework(s): none
- Package manager: Bun

### Data & infra

- File storage: local filesystem only
- Critical external services: local `git`, local `codex` CLI, local `claude` CLI

### Quality tooling

- Lint: `bun run lint`
- Unit tests: `bun test`
- Coverage gate: `bun run test:coverage` with 100% line and function coverage enforced from `coverage/lcov.info`
- Static analysis: `bun run typecheck`
- CI/CD: none

## Local environment

### Prerequisites

- Min runtime version: Bun 1.0+
- Required system tools: `bun`, `git`
- Optional system tools: `codex`, `claude`
- Local services to start: none

### Setup

```sh
bun install
bun install -g .
```

## Tools

- Check official documentation first when a change depends on a library, framework, CLI, or API outside this repo.
- Use `Context7` as the preferred way to retrieve that official documentation.
- After checking the docs, read the local implementation before editing it so the change matches the current repo structure and behavior.
- If the docs suggest a newer or better approach than the current code, treat that as a deliberate change and update code, tests, and docs together.

## Commands

Only list commands that are tested and working.

| Action | Command |
| ------ | ------- |
| Run locally | `bun run bin/pairmind.ts codex` |
| Show help | `bun run bin/pairmind.ts --help` |
| Install globally | `bun install -g .` |
| Lint | `bun run lint` |
| Typecheck | `bun run typecheck` |
| Coverage | `bun run test:coverage` |
| All tests | `bun test` |
| Full quality gate | `bun run check` |
| Targeted tests | `bun test test/pairmind.test.ts` |

## Architecture

### Overview

The codebase is a small CLI split into three responsibilities:

- `src/cli.ts` parses arguments, prints help, and owns process lifecycle
- `src/providers.ts` defines supported providers and provider metadata
- `src/session.ts` owns Git worktree creation, cleanup safety checks, and provider process launching

The main data flow is: parse CLI args, resolve the provider, find the repo root, create a worktree and branch, spawn the provider inside that worktree, then remove the session only if it is still pristine.

### Key directories / modules

| Path | Role |
| ---- | ---- |
| `bin/pairmind.ts` | executable entrypoint exposed as the CLI binary |
| `src/cli.ts` | CLI parsing, validation, help output, and exit behavior |
| `src/providers.ts` | provider registry for Codex and Claude |
| `src/session.ts` | Git helpers, worktree lifecycle, cleanup logic, and process spawning |
| `test/pairmind.test.ts` | helper, parser, worktree, and provider launch tests against temp repos |

### Boundaries

- What reads data: CLI args, Git metadata, filesystem state
- What writes data: Git worktrees, Git branches, terminal output
- What talks to the outside: spawned `git`, `codex`, and `claude` processes
- What must NOT depend on what:
  - provider-specific metadata must not own session cleanup policy
  - cleanup logic must not depend on terminal formatting concerns
  - tests must not depend on live provider APIs or remote accounts

### Known fragility & tech debt

- provider support is intentionally shallow and only covers process launching
- there is no build or release pipeline yet
- CLI UX and naming may still evolve as the product direction sharpens

## Project rules

### Worktree deletion must be conservative

- Never delete a session worktree unless it is provably pristine.
- In this repo, "pristine" means no `git status --porcelain` output and `HEAD` still matches the base commit used to create the worktree.
- If there is any doubt, keep the worktree and print that it was kept.

Why: silent work loss is the worst failure mode of this product.

Reference: [src/session.ts](/Users/ilanbuchoux/dev/sandbox/src/session.ts)

Common mistake:
- Checking only for a clean working tree and forgetting that the user may have created commits.

### Keep the session layer provider-agnostic

- Model the product around sessions, worktrees, and providers.
- Provider-specific differences belong in the provider registry and launch wiring, not in cleanup or Git policy.
- New providers should be added by extending the registry and reusing the same session lifecycle.

Why: Pairmind is a co-creation tool, not a wrapper for a single vendor CLI.

Reference: [src/providers.ts](/Users/ilanbuchoux/dev/sandbox/src/providers.ts)

Common mistake:
- Naming core abstractions after one provider and making future support awkward.

### Validate CLI input before mutating Git state

- Parse and validate provider names and flag values before creating a worktree.
- Missing or unknown providers must fail fast with a clear CLI error.

Why: invalid input should not leave behind branches or worktrees.

Reference: [src/cli.ts](/Users/ilanbuchoux/dev/sandbox/src/cli.ts)

Common mistake:
- Starting Git mutations before confirming the provider exists.

### Test real Git behavior where it matters

- Helper functions can be unit-tested directly.
- Any behavior involving worktree creation, cleanup, or branch state must use temporary real Git repos.
- Provider launch tests should fake the provider binary locally, not call the real networked tool.

Why: the correctness risks are in Git behavior, not in pure data transformation.

Reference: [test/pairmind.test.ts](/Users/ilanbuchoux/dev/sandbox/test/pairmind.test.ts)

Common mistake:
- Mocking Git too aggressively and missing real worktree edge cases.

### Keep docs aligned with the actual CLI contract

- Whenever commands, binary names, setup steps, or supported providers change, update `README.md` and this file in the same change.
- Only document commands that were actually run successfully in this repo.

Why: Pairmind is a CLI project, so stale docs immediately create user confusion.

Reference: [README.md](/Users/ilanbuchoux/dev/sandbox/README.md)

Common mistake:
- Leaving old binary names or install flows after a rename.

## Known traps

- `git worktree remove` is safe only for untouched sessions. Dirty or divergent sessions must remain on disk.
- A clean working tree is not enough for auto-cleanup if the user created commits in the session.
- Tests that create temporary repos must configure a local Git user before committing.
- On macOS, temporary paths may appear as both `/var/...` and `/private/var/...`; path comparisons in tests should normalize via `realpath`.
- `bun link` is not the right installation flow for exposing the `pairmind` shell command here; use `bun install -g .`.

## How to work

### Non-negotiable invariants

- Zero warnings in committed code.
- No type-safety escapes without local justification.
- Validate CLI inputs before Git mutations.
- Do not swallow actionable errors silently.

### Assess blast radius first

- Small: act directly.
- Medium: state your approach before coding.
- Large: break the work into steps and keep the user informed.

### Read before writing

- Read the affected CLI, provider, session, and test code before changing behavior.
- Check existing behavior in code, tests, and docs before assuming a convention.

### After each feature

1. Add or update tests.
2. Re-run the relevant checks.
3. Remove dead names and stale docs.
4. Confirm the diff is focused and readable.

### Refactoring

- Refactoring is normal work in this repo.
- Extract duplication early.
- Keep the core session lifecycle small and explicit.
- Re-run tests and typecheck after structural changes.

### Definition of done

A task is complete when code, tests, and docs all describe the same behavior and the relevant checks pass.

## Git

- Atomic commits only.
- Don't revert changes you didn't make.
- Default branch: `main`.
- Commit messages: concise and change-oriented.

Before committing, run at minimum:

1. `bun run lint`
2. `bun run typecheck`
3. `bun run test:coverage`

## Evolving this file

- Add conventions when they become stable.
- Remove rules that stop being true.
- Prefer short, concrete, actionable sentences.
