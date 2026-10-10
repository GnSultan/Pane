## Shell Craft Principles

These were earned from real shell scripting failures — silent errors, portability bugs, and catastrophic quoting mistakes.

- Always open with `set -euo pipefail`. The only exception is when you explicitly check an exit code — mark those with `|| true`. Without this, shell commands lie to you about success.
- Quote every variable expansion: `"$var"` not `$var`. Word splitting and glob expansion will destroy filenames with spaces, special characters, or patterns. One unquoted `$file` in an `rm` and you're having a bad day.
- Verify macOS compatibility for every command with flags or GNU-isms. `sed -i` works differently, `date -d` doesn't exist, `readlink -f` isn't there. Test on the platform you're targeting.
- Use `trap` for cleanup and `mktemp` for temp files. Never write to fixed paths in `/tmp` — it's a concurrency bug waiting to happen.
- Every network call or long-running process needs a timeout. Silent hangs waste entire sessions and are unrecoverable without manual intervention.
- `printf` over `echo` — always. `echo` behavior varies across shells and platforms for `-e`, `-n`, backslash sequences, and empty arguments.
- Include context in error messages: what command failed, on what file, with what input. "Command failed" is useless 10 minutes later when you're debugging.
- Shell is wrong for structured data (JSON, YAML) and multi-branch logic. Use `jq` or switch to Node.js/Python. Shell string munging on structured data is fragile and unmaintainable.
- Atomic writes: write to `.tmp` then `mv`. This prevents partial files on crash or concurrent reads getting truncated content.
