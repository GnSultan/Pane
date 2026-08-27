---
name: verification
description: Systematic verification workflow. Load when writing code that needs to be correct — build, type-check, lint, and test before declaring work done. Prevents the most common failure mode: claiming completion with unverified work.
version: 1.0.0
tags: [verification, build, test, quality, correctness]
---

# Verification

## When to use this skill

Activate this skill when:
- Writing or editing any code that will be built or tested
- About to declare a task complete
- Working in a project with a build system (tsc, vite, webpack, etc.)
- The model has previously declared work "done" but it didn't compile

Activate **proactively** — before writing code, not after. The verification mindset changes how you work.

## The verification gate

**Never declare work done without passing the verification gate.** This is the single rule. Everything else in this skill supports it.

### Standard gate (TypeScript/Node projects)

```bash
# Stage 1: Type-check (fast, catches most errors)
npx tsc --noEmit --pretty

# Stage 2: Build (catches bundling errors)
npm run build

# Stage 3: Lint (catches style and logic issues)
npm run lint

# Stage 4: Test (if tests exist)
npm test
```

### Verification decision tree

```
tsc --noEmit
  ├─ Clean → proceed to build
  └─ Errors → FIX THEM FIRST, then re-check

npm run build
  ├─ Clean → proceed to lint
  └─ Errors → FIX THEM FIRST, then re-check

npm run lint
  ├─ Clean → proceed to test (or declare done if no tests)
  ├─ Warnings → note them, consider fixing, proceed
  └─ Errors → FIX THEM FIRST, then re-check

npm test
  ├─ All pass → declare done
  ├─ Some fail → FIX THEM FIRST, then re-check
  └─ No tests exist → note this, declare done
```

## Anti-patterns

| Anti-pattern | Why it's wrong |
|-------------|----------------|
| "I'll fix the errors later" | You won't. Fix them now. |
| "Those errors are pre-existing" | Flag them explicitly. Don't ignore them. |
| "It built on my machine" | Run it in the project directory. Always. |
| "The change is too small to need verification" | Small changes cause the most surprising breakages. |
| "I ran it in my head" | You can't. Run the actual compiler. |
| Skipping stages because they're "slow" | A slow build is faster than a broken build. |
| Adding `// @ts-ignore` to silence errors | Fix the type, don't silence the checker. |

## Project-specific verification

### Detecting the right commands

Before running verification, detect what's available:

```bash
# Check package.json for available scripts
node -e "const p = require('./package.json'); console.log(Object.keys(p.scripts || {}).join('\n'))"
```

If `build`, `lint`, or `test` scripts exist, use them. If not, adapt:
- No `build` script → run the compiler directly (`npx tsc --noEmit`)
- No `lint` script → skip the lint stage (don't guess at a linter)
- No `test` script → note it and skip (don't invent tests)

### Multi-package repos

If the project has multiple packages (monorepo, workspaces), verify each changed package independently:

```bash
cd packages/changed-package && npx tsc --noEmit
```

## Error handling during verification

When verification fails:

1. **Read the full error output** — don't skim. Every line matters.
2. **Identify the source** — is it your change or pre-existing?
3. **Fix your errors** — if the error is from your change, fix it
4. **Flag pre-existing errors** — if errors predate your change, tell the user explicitly
5. **Re-run** — after fixing, run the gate again from the top

## Principles

- Verification is not optional. It's the difference between "done" and "I think I'm done."
- The compiler is never wrong. If it says there's an error, there's an error.
- A clean build is the minimum bar. Passing tests is the real bar.
- If you skip verification, you're asking the user to debug your work. Don't.
