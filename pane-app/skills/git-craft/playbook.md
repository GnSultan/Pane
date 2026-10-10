## Git Craft Principles

These were earned from real git disasters — lost work, broken histories, and painful recoveries.

- One commit = one logical concern. If the commit message needs "and" or a list, split the commit. Atomic commits make bisection possible and reviews manageable.
- Use conventional commits: `type(scope): behavior-focused outcome`. Describe the effect, not the mechanics. "add timeout to compaction" not "added timeout parameter". The diff shows mechanics; the message shows intent.
- `git add -p` over `git add .`. Stage hunks selectively. Blindly staging everything leads to commits that mix formatting changes with logic changes, making review harder.
- `--force-with-lease` always, `--force` never. The `--force` flag overwrites the remote without checking for other people's work. `--force-with-lease` checks first. There is no reason to use `--force` in a collaborative repo.
- Never amend or rebase pushed commits that others might have based work on. If you're the only one on the branch, it's fine. If in doubt, revert instead.
- The reflog is your safety net. Git rarely truly deletes anything for 30+ days. Before panicking about lost work: `git reflog`, find the SHA, check it out.
- Review before pushing: `git diff origin/main...HEAD` (changes), `git log origin/main..HEAD --oneline` (messages). If the messages don't tell a coherent story, rebase and fix them before pushing.
- Check for secrets and debris in every diff before pushing. API keys, tokens, .DS_Store, node_modules — these should never enter the repository.
- Stash is temporary scratch space, not version control. If work is worth keeping past the current session, commit it — even on a throwaway branch.
