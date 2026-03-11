# Pairmind

Pairmind est un CLI de co-création pour lancer des sessions d'agents dans des worktrees Git isolés.

L'idée n'est pas seulement d'encapsuler un outil. Le but est de te donner un espace sûr pour réfléchir, explorer et coder à deux avec des assistants comme Codex et Claude Code, sans polluer ton repo principal.

## Ce que fait cette version

- détecte le repo Git courant
- crée un worktree dédié pour la session
- lance `codex` ou `claude` dans ce worktree
- supprime automatiquement le worktree s'il n'y a ni changements ni commits à garder
- conserve le worktree s'il contient du vrai travail

Par défaut, les worktrees sont créés à côté du repo dans `.pairmind-worktrees/<nom-du-repo>/`.

## Installation locale

```bash
bun install -g .
```

Ensuite, dans n'importe quel repo Git :

```bash
pairmind codex
pairmind claude
```

## Exemples

```bash
pairmind codex
pairmind claude -- --continue
pairmind codex --repo ~/dev/mon-projet -- --model gpt-5-codex
pairmind claude --keep
```

## Options utiles

```bash
pairmind codex --name feature-a
pairmind codex --base-dir ~/worktrees/pairmind
pairmind claude --repo ~/dev/mon-projet
pairmind --provider codex
```

## Développement

```bash
bun run lint
bun run test:coverage
bun run typecheck
bun run check
```

## Note sur Bun

`bun link` enregistre le package pour un autre projet Bun, mais ce n'est pas le bon flux pour obtenir directement la commande shell `pairmind`.

Pour installer le binaire globalement sur ta machine, utilise :

```bash
bun install -g .
```
