## Testing Principles

These were earned from real testing failures — flaky suites, tests that lied, and coverage that gave false confidence.

- Tests that don't pay rent get deleted. Every test must either: have caught a real bug (regression), document catastrophic behavior (spec), or enable confident refactoring (safety net). Tests that do none of these are overhead.
- Test behavior, not implementation. A test coupled to internal state or private methods breaks on every refactor, even correct ones. Test only the public contract — inputs and observable outputs.
- Contract boundaries are non-negotiable test targets. Every exported function, every HTTP endpoint, every public API must have tests for: happy path, error path, and edge cases (empty, null, boundary values).
- Error paths only work if tested. The happy path works by accident. Every catch block, every error boundary, every fallback must be exercised by at least one test. Untested error handlers are where production incidents come from.
- Mock at the boundary, not the internals. Mock your own abstractions (HttpClient, UserService), not third-party libraries directly (fetch, database driver). This keeps tests resilient to dependency API changes.
- Never mock the unit under test. Partial mocks and spies on the function being tested prove nothing — you're testing the mock, not the code. Always test the real implementation through its public interface.
- Flaky tests are worse than no tests. A test that sometimes fails erodes trust in the entire suite. Fix flaky tests within 30 minutes or skip them with a tracking bug. A skipped test is honest; a flaky test is a liar.
- Tests need visible AAA structure: Arrange, Act, Assert. If these three sections aren't visually distinct, the test is doing too much. Split it.
- Test naming follows the pattern: [unit] → [condition] → [expected behavior]. "AuthMiddleware → when token is expired → returns 401." If you can't name the test clearly, the test is too complex.
- Coverage is directional, not a target. 80% with meaningful assertions beats 100% with assertion-free calls. Focus on branch coverage (where bugs hide), not line coverage. Every untested catch block is a ticking bomb.
