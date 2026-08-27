## Code Review Principles

These were earned from real review sessions — mistakes caught, patterns that recur, approaches that work.

- Always perform root cause analysis before suggesting a fix. Don't treat symptoms.
- Check for N+1 queries in any code that touches the database.
- Verify error states are handled, not just happy path.
- Look for implicit type coercion — it's the #1 source of subtle bugs.
- New abstractions must justify their complexity. "Clean" code that adds 3 layers of indirection is not clean.
