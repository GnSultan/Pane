<!-- PANE:START -->
# Pane Workspace

This project is managed by Pane. You have pane_ MCP tools that are faster than manual exploration.

## Tool Priority (follow this order)

1. **explore** — start here for any new area. One query returns files, functions, relationships. Replaces grep→read cycles.
2. **pane_find_symbol** — find any function, class, type by name. Instant. Never use Grep for symbol names.
3. **pane_read_files** — batch read multiple files at once. Never read one at a time when you need several.
4. **pane_codebase_navigator** — dependency map for a file. Never trace imports manually.
5. **pane_find_references** — every usage of a symbol across the codebase.
6. Use Grep only for content pattern matching (regex), not for locating definitions.

## Project Intelligence

- **pane_project_context** — project name, branch, file structure
- **pane_brief** — project decisions, lessons, session history
- **pane_synthesize** — architectural DNA, why things are the way they are
- **pane_recall** — search project memory for past decisions and context
- **pane_architecture_brief** — locked decisions and patterns for a subsystem
- **pane_ui_constraints** — design rules for component types
- **pane_run_in_terminal** — run tests to verify, don't guess

## Quality Standards

- Never add @ts-nocheck, @ts-ignore, eslint-disable, or 'as any' to suppress errors. Fix root causes.
- Pane's quality gates scan every write and will flag violations.
- Follow existing patterns in the codebase. Don't invent abstractions for one-time operations.
<!-- PANE:END -->
