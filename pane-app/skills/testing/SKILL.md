---
name: testing
description: Test strategy — what to test, how to structure tests, mocking philosophy, and TDD workflow. Tests that pay rent, not tests that collect dust.
version: 1.0.0
tags: [testing, tdd, unit-tests, integration-tests, mocking]
extends: []
conflicts: []
requires: []
provides: [testing, tdd, test-strategy, mocking]
priority: 5
---

# Testing

## When to use this skill
Activate when:
- Writing tests (unit, integration, e2e)
- Deciding what to test and what not to test
- Setting up mocking, stubbing, or test fixtures
- Following TDD or test-first workflow
- Reviewing test coverage or test quality
- Debugging flaky tests

## First principle: tests are a liability until they prove their value

Every test has a cost: time to write, time to run, time to maintain, time to understand when it fails. A test that never catches a real bug is pure overhead. A test that's flaky is worse than no test — it erodes trust in the entire suite.

Write tests that pay rent. Every test should either:
1. Have caught a real bug before (regression test)
2. Document a behavior that would be catastrophic if broken (spec test)
3. Enable you to refactor with confidence (safety-net test)

If a test does none of these, delete it.

## What to test

### Always test
- **Contract boundaries.** Public APIs, exported functions, HTTP endpoints. If someone outside the module calls it, test it.
- **State machines.** Transitions between states, invalid transitions, edge states. FSM bugs are the hardest to reproduce without tests.
- **Data transformations.** Parsing, serialization, encoding. Input goes in, output comes out — these are pure functions and the cheapest tests to write.
- **Error paths.** The happy path works by accident. The error paths only work if you test them. Test every catch block, every error boundary, every fallback.
- **Security boundaries.** Auth checks, rate limiting, input validation, SQL injection vectors. These failing silently is catastrophic.

### Sometimes test
- **Complex algorithms.** If you can't reason about correctness by reading the code, write a test. If the algorithm has known edge cases (empty input, duplicates, overflow), test them.
- **Glue code with non-trivial wiring.** If the DI setup or middleware chain can be misconfigured in ways the type system won't catch, test it.
- **Performance-sensitive paths with regression risk.** If a naive refactor could accidentally make it O(n²), write a test that asserts on complexity class or runtime ceiling.

### Never test
- **Trivial getters and setters.** `getName()` returning `this.name` — the test is more code than the implementation and can never fail independently.
- **Framework internals.** Don't test that Express calls your handler or that React renders a div. Test YOUR logic, not the framework's.
- **Third-party code.** Don't test that `lodash.groupBy` works. Test that YOUR code passes the right arguments and handles the result correctly.
- **Implementation details.** Don't test private methods, internal state, or how something is done. Test WHAT the observable behavior is. Tests coupled to implementation make refactoring impossible.

## Test structure

### AAA pattern: Arrange, Act, Assert
Every test should have three visible sections. If you can't see them, the test is doing too much.

```typescript
it('returns 401 when token is expired', () => {
  // Arrange
  const expiredToken = createToken({ exp: Date.now() - 1000 });
  const handler = createAuthHandler();

  // Act
  const result = handler.verify(expiredToken);

  // Assert
  expect(result.status).toBe(401);
  expect(result.error.code).toBe('TOKEN_EXPIRED');
});
```

### One assertion per test... mostly
The ideal is one behavior per test. But "one assertion" is a guideline, not a law. Multiple assertions on the same logical fact are fine:

```typescript
// Fine — all assertions verify the same fact: "the user was created correctly"
expect(user.name).toBe('Alice');
expect(user.email).toBe('alice@example.com');
expect(user.role).toBe('admin');

// Not fine — testing two different behaviors
expect(user.name).toBe('Alice');
expect(logger.warn).toHaveBeenCalled(); // different concern, different test
```

### Test naming
```
[unit under test] → [condition] → [expected behavior]
```
Examples:
- `AuthMiddleware → when token is expired → returns 401 with TOKEN_EXPIRED`
- `compactConversation → with under 200 messages → uses inline fast path`
- `parseConfig → when file is missing → throws ConfigError with path`

If you struggle to name the test, the test might be testing too many things.

## Mocking

### Mock only what you own
Mock your own abstractions, not third-party libraries. If you're calling `fetch`, don't mock `fetch` — wrap it in an `HttpClient` and mock that. This keeps tests resilient to API changes in dependencies.

### Mock at the boundary
Mock at the outermost layer of YOUR code, not deep in the call stack. If your handler calls `userService.getById()` which calls `database.query()`, mock `userService`, not `database`. Mocking internals creates tests that pass when the code is broken.

### Stub vs mock vs spy
- **Stub**: returns a canned answer. "When asked for user 5, return Alice." Use for inputs.
- **Mock**: asserts it was called correctly. "Expect `sendEmail` was called with this exact payload." Use for side effects.
- **Spy**: records what happened without changing behavior. "I want to check if `log` was called, but I still want `log` to actually log." Use for diagnostics.

The distinction matters. Over-mocking (asserting on every call) produces brittle tests. Under-stubbing (not providing canned answers) produces flaky tests.

### Never mock the unit under test
If you mock the function you're testing, you're testing the mock, not the function. This is surprisingly common and always wrong.

## TDD workflow

### Red → Green → Refactor → Verify
1. **Red**: Write a failing test that defines the behavior you want. Verify it fails for the RIGHT reason (not a syntax error or missing import). If it fails for a different reason than expected, the test is wrong.
2. **Green**: Write the minimal code to make the test pass. Not the perfect code, not the elegant code — the minimal code. Hardcode the answer if the test only checks one case.
3. **Refactor**: Clean up. Remove duplication, improve names, extract functions. The test guarantees you don't break behavior.
4. **Verify**: Run all tests. A refactor in one module shouldn't break tests in another.

### When TDD adds value
- Greenfield features with clear requirements
- Bug fixes (write the test that reproduces the bug FIRST, then fix)
- API design (tests as the first consumer of your API — if it's hard to test, it's hard to use)

### When TDD slows you down
- Exploratory/spike work where you don't know the shape yet
- UI layout (visual tests are manual until you have screenshot diffing)
- Throwaway prototypes

## Flaky tests

A flaky test (one that sometimes passes, sometimes fails) is worse than no test. It erodes trust. Developers learn to ignore failures. Real bugs slip through.

### Common causes and fixes
- **Time dependency.** Don't use `new Date()` in tests. Inject a clock or pass timestamps explicitly.
- **Order dependency.** Tests should never depend on other tests running first. Each test sets up its own state.
- **Shared mutable state.** Reset databases, files, and global state between tests. Use `beforeEach`.
- **Async without await.** Every async operation in a test must be awaited or returned. A test that completes before its assertions is a false positive.
- **Network calls.** Never make real HTTP calls in unit tests. They will fail when WiFi drops, when the service is down, when rate limits hit.

### The flaky test rule
If a test fails sporadically in CI and you can't fix it within 30 minutes, skip it, file a bug, and fix it that week. A skipped test is honest. A flaky test is a liar.

## Test coverage

### Coverage is a directional metric, not a target
80% coverage with tests that verify real behavior is better than 100% coverage with tests that just call functions and don't assert anything meaningful. Coverage tells you what's UNTESTED, not what's TESTED WELL.

### What to look for in coverage gaps
- **Branches, not lines.** Line coverage is misleading. A 1-line ternary that's only tested for the true branch is 100% line coverage and 50% branch coverage. Branch coverage is where bugs hide.
- **Error handlers.** Every `catch` block should appear in coverage as tested. Untested error paths are where production incidents come from.
- **Fallback/default cases.** Switch statements where the default case is never hit. Configuration defaults that are never exercised.

## Anti-patterns

- **Testing implementation, not behavior.** "Component calls setState 3 times" → instead test "component shows the updated value after 3 clicks."
- **Mocking the unit under test.** Partial mocks, spying on the function you're testing — never.
- **Testing the framework.** Don't test React's `useState`, Express routing, or Drizzle's `select()`. Test YOUR code that uses them.
- **Incomplete assertions.** `expect(result).toBeDefined()` is almost never enough. If `result` being defined is all you care about, you don't have a meaningful test.
- **Commenting out failing tests.** Fix them or skip them with a reason. Commented-out tests are invisible to the test runner and will never be fixed.
- **Slow test suites.** A test suite that takes 10 minutes doesn't get run. Keep unit tests under 2 seconds total. Keep integration tests under 30 seconds. If it's slower, profile and parallelize.
