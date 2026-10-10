---
name: code-review
description: Deep code review with architecture analysis, bug detection, and improvement suggestions. Use when reviewing PRs, auditing code quality, or analyzing design decisions.
version: 1.0.0
tags: [review, quality, architecture, analysis]
---

# Code Review

## When to use this skill
Activate this skill when:
- Reviewing a pull request or set of changes
- Auditing an existing codebase for quality issues
- Analyzing architectural decisions and their trade-offs
- The user asks for a "review", "audit", or "analysis" of code

## Review methodology

### 1. Understand the intent
Before reviewing implementation, understand what the code is trying to accomplish. Read the surrounding context, related files, and project about. A review that misses intent is noise.

### 2. Structural analysis
- Does the change respect the existing architecture?
- Are new abstractions justified, or is complexity being added without necessity?
- Do imports form a clear dependency graph, or are there circular/spaghetti dependencies?
- Is the change at the right level of the stack, or is it leaking concerns?

### 3. Correctness
- Are edge cases handled? (null, empty, error states, boundary values)
- Are there race conditions or ordering dependencies?
- Is error handling present and appropriate — not swallowing, not leaking internals?
- Are there potential null pointer / undefined access paths?

### 4. Maintainability
- Will a future developer understand this in 6 months?
- Are names descriptive and consistent with the codebase conventions?
- Is the change documented where it's surprising, not where it's obvious?
- Are there tests that would catch a regression?

### 5. Performance
- Are there N+1 queries, unnecessary allocations, or blocking operations?
- Is data being fetched/loaded at the right time?
- Are large payloads being passed through hot paths?

## Output format

Structure the review as:

1. **Summary** (1-2 sentences): what the change does and whether it's on the right track
2. **Critical issues**: things that must be fixed before merge (correctness, security, data loss)
3. **Important issues**: things that should be fixed (design problems, maintainability)
4. **Suggestions**: things that could be improved (naming, minor optimizations)
5. **What's good**: specific things done well — be as specific as the criticism

## Principles
- Be specific. "This could be cleaner" is useless. "The `processItems` function does three things: filtering, transforming, and aggregating. Split into `filterValid`, `transformShape`, `aggregateResults`."
- One issue per point. Don't bundle.
- Reference line numbers or function names. Ground every observation in the code.
- If something is good, say so explicitly. Reviews that only find problems create adversarial dynamics.
