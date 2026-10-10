---
name: shell-craft
description: Shell command craftsmanship — robust, portable, and safe shell scripting. Use before writing any shell command, pipeline, or script that's more than a single trivial invocation.
version: 1.0.0
tags: [shell, bash, cli, scripting, commands, portable]
---

# Shell Craft

## When to use this skill
Activate when:
- Writing multi-step shell commands or pipelines
- Creating build scripts, deployment scripts, or automation
- Debugging a shell command that failed silently
- Writing commands that must work across macOS and Linux
- The command involves file operations, process management, or network calls

## First principle: shell is a minefield

Shell makes it easy to write commands that appear to work but fail silently. The gap between "ran without errors" and "did the right thing" is wide. Every shell command you write should be defensive by default.

## Safety foundations

### Always start with these
```bash
set -euo pipefail
```
- `-e`: exit on any command failure (no silent continues)
- `-u`: treat unset variables as errors (no silent empty strings)
- `-o pipefail`: pipeline fails if any command in it fails, not just the last one

Without these, shell commands lie to you. The only exception is when you explicitly WANT to check a command's exit code — use `|| true` to mark those intentionally.

### Quoting discipline
- Always quote variables: `"$var"` not `$var` (prevents word splitting and glob expansion)
- Use single quotes for literal strings, double quotes when you need variable expansion
- Never embed variables in unquoted contexts: `rm $file` will destroy you when `file="*.txt"`

### Temporary files and cleanup
```bash
trap 'rm -f "$tmpfile"' EXIT
tmpfile=$(mktemp) || exit
```
Always use `trap` for cleanup, `mktemp` for temp files. Never write to fixed paths in `/tmp`.

## Portability rules

### macOS vs Linux differences
These trip up models constantly because training data skews Linux:

| GNU (Linux) | POSIX/macOS alternative |
|---|---|
| `sed -i` | `sed -i ''` (macOS) or use `perl -pi -e` |
| `cp --parents` | Use `install -D` or `mkdir -p` + `cp` |
| `date -d` | Use `date -j -f` on macOS, or avoid entirely |
| `readlink -f` | Use `realpath` or a fallback |
| `grep -P` | Use `grep -E` (extended regex) or `perl -ne` |
| `echo -e` | Use `printf` instead (always portable) |
| `base64 -d` | `base64 -D` on macOS |

When writing commands for Pane (Electron, runs on macOS primarily), prefer macOS-compatible forms. When writing for deployment (Linux servers), prefer GNU forms.

### Prefer portable alternatives
- `printf` over `echo` (always)
- `[ "$a" = "$b" ]` over `[[ $a == $b ]]` (POSIX sh compatibility)
- `#!/usr/bin/env bash` over `#!/bin/bash` (PATH-aware)
- Avoid `declare`, `local`, arrays in POSIX-only contexts

## Command patterns

### Timeout pattern
```bash
timeout 30 some-command || { echo "timed out after 30s" >&2; exit 1; }
```
Every network call, download, or long-running process needs a timeout. Silent hangs waste sessions.

### Retry pattern
```bash
for i in $(seq 1 5); do
  some-command && break
  sleep $((2 ** i))  # exponential backoff
done
```

### Idempotent file operations
```bash
# Create if not exists — safe to run repeatedly
mkdir -p "$dir"
[ -f "$file" ] || echo "default" > "$file"

# Atomic write — no partial file on crash
echo "$content" > "$file.tmp" && mv "$file.tmp" "$file"
```

### Error context
```bash
some-command || { echo "failed: some-command on $file" >&2; exit 1; }
```
Always include what failed and on what. "Command failed" is useless 10 minutes later.

## When NOT to use shell

Shell is the wrong tool when:
- **Data has structured formats** (JSON, YAML, XML): use `jq`, `yq`, or a scripting language. Shell string munging on structured data is fragile.
- **Logic has more than 3 branches**: use Node.js/Python. Shell conditionals are error-prone at scale.
- **You need proper error handling**: use a real language. Shell's error handling is `set -e` and traps, which have edge cases.
- **Performance matters**: shell spawns a process for almost everything. For bulk operations, use a single process.
- **Security boundaries are involved**: never use shell for sanitization. Use a proper parser.

## Verification checklist

After writing a shell command, verify:
1. Does it handle empty input? (no arguments, empty file, no matches)
2. Does it handle spaces/special chars in filenames? (use `-print0`/`xargs -0` or `find -exec`)
3. Does it fail loudly on error, or silently continue?
4. Does it clean up temp files?
5. Does it work on both macOS and Linux (if applicable)?
6. Is there a timeout? Could it hang forever?
