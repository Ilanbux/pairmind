export type ProviderName = "claude" | "codex";

export interface ProviderDefinition {
  binary: string;
  description: string;
  label: string;
  name: ProviderName;
}

export const PROVIDERS = {
  claude: {
    binary: "claude",
    description: "Launch Claude Code inside a fresh worktree.",
    label: "Claude Code",
    name: "claude",
  },
  codex: {
    binary: "codex",
    description: "Launch OpenAI Codex inside a fresh worktree.",
    label: "OpenAI Codex",
    name: "codex",
  },
} as const satisfies Record<ProviderName, ProviderDefinition>;

export function isProviderName(value: string): value is ProviderName {
  return value in PROVIDERS;
}

export function getProvider(value: string): ProviderDefinition | undefined {
  if (!isProviderName(value)) {
    return undefined;
  }

  return PROVIDERS[value];
}

export function listProviders(): ProviderDefinition[] {
  return Object.values(PROVIDERS);
}
