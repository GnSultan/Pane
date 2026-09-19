## Performance Principles

These were earned from real performance failures — optimizing the wrong thing, memoizing everything, and ignoring the critical path.

- Measure before you optimize. Never optimize without a baseline number. If you don't have a number, you don't have a problem — you have a feeling. Feelings don't justify complexity.
- One change between measurements. Change three things and it gets faster → you don't know which worked. Change three things and it gets slower → you don't know which to revert. One change, one measurement, then decide.
- Profile on the slowest target device, not your dev machine. A MacBook Pro hides problems that destroy a 4GB Chromebook. The user's experience is what matters.
- The optimization loop: measure baseline → profile to find bottleneck → hypothesize cause → make one change → measure again → repeat or stop. Stop when the bottleneck is no longer the bottleneck.
- Wall clock time is the only metric that matters for UX. Not CPU time, not throughput, not ops/sec. How long does the user wait? That's the number to optimize.
- Bundle cost is a dependency selection criterion. Check bundle size BEFORE adding a dependency. Moment.js (70KB) vs date-fns (2KB tree-shaken). Lodash (70KB) vs native array methods (0KB). This is a one-time check that pays off forever.
- Render performance: find components rendering when props didn't change (React DevTools Profiler), not components that are slow. Fixing unnecessary re-renders is cheaper than optimizing expensive renders.
- Virtualize lists over 100 items. Rendering 10,000 DOM nodes when 20 are visible is the most common UI performance bug. It's also the easiest to fix.
- Avoid layout thrashing: never read layout properties (offsetHeight, getBoundingClientRect) and write layout properties (style.width, classList.add) in the same synchronous loop. Batch reads, then batch writes.
- Caching has a cost. Only cache when: data is expensive to compute, changes infrequently, and stale data is tolerable. If any of these is false, caching makes things worse — stale bugs, invalidation complexity, memory pressure.
- Stale-while-revalidate is the best default caching strategy. Serve cached data immediately (fast), refresh in background (fresh), update next time (never stale for more than one cycle).
- Blocking the main thread for >50ms causes visible jank. Move synchronous work over 50ms to a worker thread, split into idle callbacks, or stream it. A 60fps frame is 16ms — the browser needs half of that.
