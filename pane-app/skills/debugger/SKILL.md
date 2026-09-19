---
name: debugger
description: Systematic debugging methodology. Load when investigating a bug, diagnosing a failure, or fixing something that broke. Replaces guesswork with root cause analysis — find the cause before proposing the fix.
version: 1.0.0
tags: [debugging, root-cause, diagnosis, investigation]
---

# Debugger

## When to use this skill

Activate this skill when:
- Something broke and you don't know why
- A test, build, or runtime error needs investigation
- You're tempted to "just try something" to see if it fixes the problem
- The user reports a bug
- A previously working feature stopped working

Do **not** activate when the cause is already clear and the fix is straightforward. This skill is for diagnosis, not for known fixes.

## The debugging method

### Step 0: Stop. Don't guess.

The single most important rule: **never propose a fix before understanding the cause.** Guessing wastes time, introduces new bugs, and erodes trust. If you don't know why something broke, say so and investigate.

### Step 1: Reproduce

Before anything else, reproduce the issue:
- Run the exact command or action that fails
- Capture the full error output — stack traces, error codes, line numbers
- Note the exact state: what branch, what file, what input

```bash
# Reproduce a build failure
npx tsc --noEmit --pretty 2>&1 | head -50

# Reproduce a runtime error
node path/to/failing-script.js 2>&1

# Reproduce a test failure
npm test -- --testPathPattern="failing-test" 2>&1
```

If you can't reproduce it, you can't fix it. Tell the user what you tried and ask for more details.

### Step 2: Bisect

Find the exact change that introduced the bug:

1. **Temporal bisection**: If you know it worked before, find the commit that broke it:
   ```bash
   git log --oneline -20  # recent history
   git diff HEAD~1 -- path/to/failing/file.js  # last change to this file
   ```

2. **Code bisection**: Comment out or simplify sections until the bug disappears. The last section removed before it stops is the culprit:
   ```bash
   # Binary search through code: comment half, test. If bug persists,
   # the culprit is in the other half. Repeat.
   ```

3. **Data bisection**: If the bug depends on input, find the minimal input that triggers it.

### Step 3: Root cause analysis

Once you've isolated the cause, ask **why** five levels deep:

```
Bug: Build fails with TS2345

Why? → Wrong argument type passed to db.query()
Why? → The argument object is missing the 'schema' property
Why? → The function expects ColumnDef[] but got a plain object
Why? → The calling code wasn't updated when ColumnDef changed
Why? → The type change was made without checking call sites

Root cause: Type contract changed without call site audit.
Fix: Add 'schema' property at the call site, AND grep for all other call sites.
```

The root cause is rarely at the surface. Keep asking why until you reach a process or architecture decision.

### Step 4: Fix the cause, not the symptom

| Symptom fix (wrong) | Root cause fix (right) |
|---------------------|----------------------|
| Add `// @ts-ignore` | Fix the type mismatch |
| Add a null check | Figure out why it's null in the first place |
| Increase a timeout | Fix whatever is slow |
| Catch and suppress the error | Fix what's throwing |
| Add more memory | Fix the leak |
| Add a workaround in one place | Fix the broken contract everywhere |

### Step 5: Verify the fix

After applying the fix:
1. Reproduce the original failure — it should be gone
2. Run the full verification gate (build, lint, test)
3. Check for regressions: does the fix break anything else?

## Anti-patterns

| Anti-pattern | Why it's wrong |
|-------------|----------------|
| "Let me try this and see if it works" | You're guessing. Diagnose first. |
| "It's probably a..." | Don't speculate. Check. |
| "This should fix it" | Run the test. Verify. Then say "this fixes it." |
| "I'll fix the symptom for now" | You're creating technical debt. Fix the cause. |
| Changing multiple things at once | You won't know which change fixed it. Change one thing, test, repeat. |
| "I can't reproduce it, so I'll just..." | Stop. Tell the user. Don't guess. |
| Blaming the framework/tool/library | It's almost never the tool. Check your code first. |

## Tools for diagnosis

### Git archaeology

```bash
# Find when a line was last changed
git blame path/to/file.js -L 100,110

# Show the commit that changed a file
git log --oneline -5 -- path/to/file.js

# Show what changed in a specific commit
git show <commit-hash> -- path/to/file.js

# Search commit messages
git log --oneline --all --grep="keyword"
```

### Code archaeology

```bash
# Find all call sites of a function
grep -rn "functionName(" --include="*.ts" --include="*.mjs"

# Find where a type is defined
grep -rn "interface ColumnDef" --include="*.ts"

# Find all imports of a module
grep -rn "from.*module-name" --include="*.ts" --include="*.mjs"
```

### Runtime diagnosis

```bash
# Check Node version (many bugs are version-specific)
node --version

# Check installed packages
npm ls 2>&1 | head -20

# Check for peer dependency issues
npm ls 2>&1 | grep -i "unmet\|peer\|invalid"
```

## Principles

- The bug is almost always in your code, not the framework. Start there.
- Reproduce, bisect, understand, fix, verify. In that order. Always.
- If you don't know why a fix works, it's not a fix — it's a coincidence.
- Every bug is a chance to learn something about the system. Don't waste it by fixing the symptom.
