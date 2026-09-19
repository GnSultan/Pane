---
name: typescript
description: TypeScript error prevention and type-safety patterns. Load when writing or reviewing TypeScript code, fixing TS errors, or working in a project with strict TypeScript config. Embeds Pane's accumulated TS failure patterns as active checks.
version: 1.0.0
tags: [typescript, types, errors, prevention]
---

# TypeScript

## When to use this skill

Activate this skill when:
- Writing or editing TypeScript files
- Fixing TypeScript compilation errors
- Designing function signatures, interfaces, or types
- Working in a project with `strict: true` or `moduleResolution: "node16"` / `"nodenext"`
- The model has produced TS errors in a previous turn

Activate **proactively** — before writing TS code, not after the errors.

## Active checks — apply before every TypeScript edit

These are hard rules derived from actual model failure patterns. Check them before finalizing any TypeScript change.

### 1. Import extensions (TS2835)

When `moduleResolution` is `"node16"` or `"nodenext"`, **every relative import must include the explicit `.js` extension**:

```typescript
// ✓ Correct
import { foo } from "./utils.js";
import { bar } from "../lib/helpers.js";

// ✗ Wrong — will produce TS2835
import { foo } from "./utils";
import { bar } from "../lib/helpers";
```

**Check:** Before finalizing any file with relative imports, verify every one ends in `.js` (or `.mjs` for ESM files).

### 2. Explicit type annotations (TS7006, TS7031)

**Never** rely on implicit `any`. Annotate:
- All function parameters
- All destructured bindings
- All `catch` clause variables

```typescript
// ✓ Correct
function process(data: string, options: { verbose: boolean }): Result {
  const { verbose }: { verbose: boolean } = options;
  // ...
}
try { /* ... */ } catch (err: unknown) {
  if (err instanceof Error) { /* ... */ }
}

// ✗ Wrong — implicit any
function process(data, options) { /* ... */ }
const { verbose } = options;
try { /* ... */ } catch (err) { /* ... */ }
```

**Check:** Scan every function signature, destructuring, and catch clause for unannotated parameters.

### 3. Overload and argument verification (TS2769, TS2345)

Before finalizing any function call, verify:
- The arguments match the **exact** expected overload signature
- Complex generic arguments (database column objects, etc.) match the expected shape
- No extra or missing properties in object arguments

```typescript
// ✓ Correct — explicit type matching
const columns: ColumnDef[] = [
  { name: "id", type: "integer" },
];
db.query(columns);

// ✗ Wrong — implicit shape that may not match
db.query([
  { name: "id", type: "integer" },
]);
```

**Check:** For any function call with 3+ arguments or complex object arguments, trace to the type definition and verify alignment.

### 4. Build verification gate

**Never** declare work done without running the TypeScript compiler:

```bash
npx tsc --noEmit --pretty
```

If there are errors — even ones that seem pre-existing — fix them or flag them explicitly. A clean type-check is the minimum bar for completion.

## Common failure patterns

These are the patterns that produce the most model errors. Memorize them.

| Pattern | Error | Fix |
|---------|-------|-----|
| Relative import without `.js` | TS2835 | Add `.js` extension |
| Unannotated function param | TS7006 | Add explicit type |
| Unannotated destructuring | TS7031 | Add type annotation |
| Unannotated catch clause | TS7031 | `catch (err: unknown)` |
| Wrong overload arguments | TS2769 | Verify against type def |
| Wrong argument type | TS2345 | Check expected type, fix or cast |
| Missing property in object arg | TS2345 | Add required property |
| Extra property in object arg | TS2345 | Remove excess property |

## Workflow

1. **Check tsconfig** — read `tsconfig.json` to know `moduleResolution`, `strict`, `target`, `paths`
2. **Write with annotations** — every parameter, destructuring, and catch clause gets an explicit type
3. **Verify imports** — scan relative imports for missing `.js` extensions
4. **Verify calls** — for complex function calls, trace argument types
5. **Run the compiler** — `npx tsc --noEmit --pretty` before declaring done

## Principles

- TypeScript errors are almost always the model's fault, not the user's. Don't blame the config.
- Annotating types is faster than debugging implicit `any` errors. Do it upfront.
- If you're unsure about a type, look it up — don't guess.
- A clean `tsc --noEmit` is non-negotiable before declaring work complete.
