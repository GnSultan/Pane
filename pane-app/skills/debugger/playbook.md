## Debugging Principles

Earned from real debugging sessions across Pane's codebase.

- Always bisect before speculating. Evidence over intuition, every time.
- Reproduce the bug before touching code. If you can't reproduce, you're guessing.
- Ask "why" at least twice beyond the surface cause. The first answer is rarely the root.
- Fix the class of bug, not the instance. A null check fixes this crash; a type system fix prevents all crashes of this shape.
- Record the root cause (pane_remember) so future sessions don't re-discover it.
