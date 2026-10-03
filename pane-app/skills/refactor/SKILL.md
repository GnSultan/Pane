---
name: refactor
description: Systematic refactoring with checkpoint discipline, blast-radius awareness, and incremental verification. Use before any restructuring, renaming, extraction, or cleanup task.
version: 1.0.0
tags: [refactor, restructure, cleanup, transform]
---

# Refactor

## When to use this skill
Activate when the task involves:
- Renaming a symbol, file, or module
- Extracting a function, component, or module
- Restructuring data flow or architecture
- Cleaning up technical debt or dead code
- Reorganizing the file tree
- Any change that touches more than 3 files

## Core principle: one atomic change at a time

Refactoring failures happen when you change too much at once and lose the thread. The antidote is atomicity: each change is one thing, verified independently, and committed separately. If a change breaks something, you know exactly which one.

## Refactoring workflow

### Phase 1: Map the blast radius
Before touching any code:
1. Use `pane_find_references` on every symbol you plan to change. Know every call site.
2. Use `pane_codebase_navigator` to understand the import graph. What imports this? What does this import?
3. Use `pane_knowledge_graph` to check for connected decisions/patterns. Don't violate accumulated principles.
4. Document the current behavior. Know what "correct" looks like before you change it.

### Phase 2: Create a checkpoint
Always call `pane_checkpoint` with a descriptive label before starting. Refactors are the highest-risk edits — being able to revert to exact known state is non-negotiable.

### Phase 3: Execute incrementally
For each atomic change:
1. Make the change (rename, extract, move, delete)
2. Update all references — every import, every call site, every type reference
3. Run verification immediately: `tsc --noEmit` (TypeScript) or the equivalent
4. If it passes, checkpoint again. If it fails, fix before moving on.
5. Move to the next atomic change.

Never batch multiple renames or extractions into one step. "I'll fix them all at once" is how regressions are born.

### Phase 4: Final verification
After all atomic changes:
1. Full build (`npm run build` or equivalent)
2. Full test suite
3. Linter
4. Manual review: did you change behavior, or just structure?

## Refactoring patterns

### Extract function
- Identify the cohesive block of logic
- Determine inputs (parameters) and outputs (return value)
- Name the function for what it returns or what it does, not how
- Replace the block with a call. Verify. Move on.

### Rename symbol
- Use IDE refactoring tools when available (they handle references)
- If doing manually: find every reference FIRST, then rename declaration, then update each reference one file at a time
- Search for string mentions in comments, docs, and config files — these aren't caught by type checkers

### Move file/module
- Update every import path across the entire codebase
- Check for dynamic imports, require() calls, and config file paths
- Verify the build resolves the new path (bundlers may have aliases)

### Delete dead code
- Verify it's truly dead: `pane_find_references` on every exported symbol
- Check for dynamic access patterns (string-based lookup, reflection)
- Delete in reverse dependency order: leaf modules first, then their now-unused dependencies

## Anti-patterns — never do these

- **"While I'm here" refactoring**: don't fix unrelated things in the same change. It muddies the diff and makes bisection useless.
- **Rewrite-in-place**: don't rewrite a function's internals while also moving it. Move first (structure change), then rewrite (behavior change). Two commits.
- **Mixed behavior+structure**: changing what code does AND how it's organized in one commit. These are separate concerns.
- **No verification between steps**: if you make 5 changes and the build fails, you now have to debug 5 things.
- **Deleting "just in case" code**: if you don't understand why something exists, investigate before deleting. It may be load-bearing.

## When to say no

Ask yourself before refactoring:
- Is this change making the codebase easier to change in the future, or just different?
- Am I removing duplication or moving it?
- Will a future developer understand this better, or did I just add abstraction layers?

If you can't articulate the concrete benefit, don't refactor. "Cleaner" isn't a benefit by itself — describe the specific future change that becomes easier.
