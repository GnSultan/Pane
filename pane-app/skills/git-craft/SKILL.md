---
name: git-craft
description: Git workflow mastery — atomic commits, clean history, safe branching, and surgical undo. Use before any git operation more complex than add/commit/push.
version: 1.0.0
tags: [git, version-control, commits, history, branching, undo]
---

# Git Craft

## When to use this skill
Activate when:
- Making commits (beyond trivial single-file changes)
- Branching, merging, or rebasing
- Undoing or fixing a mistake
- Preparing code for review or PR
- The user asks about git workflow, history, or branching strategy

## First principle: history is a liability if it's wrong, an asset if it's right

Bad git history wastes everyone's time. Giant commits that mix concerns. Messages like "fix" or "wip". Force-pushes that lose work. Merge conflicts that could have been avoided. The goal of git craft is history that a future developer can read like a narrative — each commit tells a clear story of one change.

## Commit discipline

### Atomic commits
One commit = one logical change. Not one file, not one function — one CONCERN.

Good commits:
- "Extract token validation into auth middleware"
- "Fix race condition in queue worker shutdown"
- "Add timeout to backup upload with progress events"

Bad commits:
- "Fix stuff" (what stuff? why?)
- "Update auth.ts, worker.ts, config.json" (what connects these?)
- "WIP" (incomplete thought)

If you can't write a good message, the commit isn't atomic enough. Split it.

### Conventional commits
```
type(scope): behavior-focused outcome
```

Types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore`, `revert`

The key: describe what the change DOES, not what you did. "add timeout to compaction" not "added timeout parameter to compact method". The former tells the reader the outcome; the latter tells them the mechanics (which they can read in the diff).

### When to amend vs create new commit
- **Amend**: the commit hasn't been pushed, and you're fixing a typo, adding a forgotten file, or clarifying the message. The change is the same logical unit.
- **New commit**: the commit has been pushed, or it's a different logical change. Never amend pushed history unless you're the only one on the branch and you know what you're doing.

## Branching

### When to create a branch
- Any change that takes more than one commit
- Any change that might need to be reverted independently
- Any experimental work that might be abandoned
- Before a risky refactor (so you can `git reset --hard` back to safety)

### Branch naming
```
type/description
```
Examples: `fix/timeout-backup`, `feat/skill-discovery`, `refactor/ipc-chunking`

Short, descriptive, no ticket numbers (those go in commit bodies, not branch names).

## Merging vs rebasing

### Rebase: linear history, clean narrative
Use when:
- Your branch is behind main and you want to integrate upstream changes cleanly
- You're preparing a feature branch for PR (squash fixup commits, write good messages)
- The branch hasn't been shared with others

```bash
git fetch origin
git rebase origin/main
# Resolve conflicts per-commit, then:
git push --force-with-lease
```

### Merge: preserve the historical truth
Use when:
- The branch has been shared and others are working on it
- You want an explicit merge commit to mark integration
- The branch history is already clean and tells a good story

### Never: force-push without `--force-with-lease`
`--force` overwrites the remote blindly. `--force-with-lease` checks that nobody else pushed to the branch. Always use the latter.

## Undo operations

### Undo uncommitted work
```bash
git checkout -- <file>       # discard file changes
git reset --hard HEAD         # discard everything (nuclear option)
git stash                     # save for later, don't discard
```

### Undo a commit (not pushed)
```bash
git reset --soft HEAD~1       # undo commit, keep changes staged
git reset --mixed HEAD~1      # undo commit, keep changes unstaged
git reset --hard HEAD~1       # undo commit, delete changes (nuclear)
```

### Undo a commit (pushed)
```bash
git revert <sha>              # create a new commit that undoes the old one
```
Never reset pushed history that others might have pulled. Revert is safe; reset is not.

### Recover lost commits
```bash
git reflog                    # find the lost SHA
git checkout <sha>            # recover it
```
Git rarely truly deletes anything for 30+ days. The reflog is your safety net.

## Pre-push checklist

Before pushing:
1. **Review the diff**: `git diff origin/main...HEAD` (what actually changed vs main)
2. **Review the log**: `git log origin/main..HEAD --oneline` (commit messages tell the story)
3. **Check for secrets**: scan for API keys, tokens, passwords in the diff
4. **Check for debris**: `.DS_Store`, `node_modules/`, build artifacts — these should be in `.gitignore`, not commits
5. **Run the build**: never push code you haven't built and tested locally

## Common workflows

### Starting a fix
```bash
git checkout -b fix/description
# make changes
git add -p                    # stage hunks selectively, not wholesale
git commit -m "fix(scope): behavior-focused outcome"
git push -u origin fix/description
```

### Cleaning up before PR
```bash
git rebase -i origin/main     # interactive rebase: squash, reword, reorder
# Write good commit messages for each logical unit
git push --force-with-lease
```

### Integrating upstream changes
```bash
git fetch origin
git rebase origin/main        # get latest, replay your commits on top
# Resolve conflicts, then:
git push --force-with-lease
```

## Anti-patterns

- **`git add .`** — stage everything blindly. Use `git add -p` to review before staging.
- **`git commit -m "fix"`** — garbage message. If it's one word, it's not a real message.
- **`git push --force`** — use `--force-with-lease` always.
- **Mixing concerns** — a commit that fixes a bug AND reformats code AND adds a feature. Three commits, not one.
- **Committing generated files** — build output, node_modules, .DS_Store. These go in .gitignore.
- **`git stash` as version control** — stash is temporary. If you have work worth keeping, commit it (even on a throwaway branch).
