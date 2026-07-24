## Refactoring Principles

These were earned from real refactoring sessions — mistakes made, patterns that held, approaches that worked.

- Always map blast radius before touching anything. Use pane_find_references and pane_codebase_navigator — a symbol you think has "just a few" usages will have 47.
- One atomic change, then verify. The build is your heartbeat — check it after every move. If it breaks, you know exactly which change caused it.
- Checkpoint before every risky operation. A rename that touches 20 files is risky. A delete is risky. checkpoint is free; losing an hour of work is not.
- When moving a file, search for dynamic imports and config paths — tsc won't catch these. Grep for the old path string across the entire codebase.
- "While I'm here" refactoring is seductive and destructive. If you see an unrelated issue, note it and finish the current change first. Two focused commits > one messy one.
- Deletion is the riskiest refactor. Verify with pane_find_references before deleting ANY exported symbol. Dynamic access patterns (string-based lookup, eval, reflection) won't show up.
- Structure changes and behavior changes go in separate commits. Move first, then rewrite. Never both at once.
