# codex-wt

Petit CLI pour lancer `codex` dans un worktree Git isolé à chaque session.

## Ce que fait cette première version

- détecte le repo Git courant
- crée un worktree dédié sur une branche éphémère
- lance `codex` dans ce worktree
- supprime automatiquement le worktree si rien n'a été modifié ni commit
- conserve le worktree s'il contient du travail à garder

Par défaut, les worktrees sont créés à côté du repo dans `.codex-worktrees/<nom-du-repo>/`.

## Installation locale

```bash
bun link
```

Ensuite, dans n'importe quel repo Git :

```bash
codex-wt
```

Avec des arguments passés à `codex` :

```bash
codex-wt -- --help
codex-wt -- model gpt-5-codex
```

## Options utiles

```bash
codex-wt --keep
codex-wt --name feature-a
codex-wt --base-dir ~/worktrees/codex
codex-wt --repo ~/dev/mon-projet
```

## Développement

```bash
bun test
```
