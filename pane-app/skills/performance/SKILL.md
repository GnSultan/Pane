---
name: performance
description: Performance optimization — profiling, measurement, and targeted optimization. Make it work, make it right, make it fast — in that order.
version: 1.0.0
tags: [performance, optimization, profiling, caching, bundle-size]
extends: []
conflicts: []
requires: []
provides: [performance, profiling, optimization, caching]
priority: 5
---

# Performance

## When to use this skill
Activate when:
- Profiling or measuring performance
- Optimizing rendering, network, or computation
- Debugging slow interactions or jank
- Setting up caching or lazy loading
- Reviewing bundle size or load time
- The user asks "why is this slow?"

## First principle: measure twice, cut once

Premature optimization is the root of all evil — but so is never optimizing. The middle path: profile first, identify the actual bottleneck (not what you assume it is), optimize that one thing, measure again to confirm improvement, then stop.

Never optimize without a baseline measurement. If you don't have a number, you don't have a problem — you have a feeling. Feelings don't justify complexity.

## Profiling methodology

### The optimization loop
```
1. Measure → get a baseline number
2. Profile → find the bottleneck
3. Hypothesize → what's causing it?
4. Optimize → make one change
5. Measure → did it improve?
6. Repeat or stop
```

Never make multiple optimizations between measurements. If you change three things and it gets faster, you don't know which one worked. If it gets slower, you don't know which one to revert.

### Tools by platform
- **Browser/Electron renderer**: Chrome DevTools Performance tab, Lighthouse, React DevTools Profiler
- **Node.js main process**: `node --inspect` + Chrome DevTools, `clinic doctor`, `0x` flamegraphs
- **Bundle**: `vite build --profile`, `rollup-plugin-visualizer`, `webpack-bundle-analyzer`
- **Network**: Chrome DevTools Network tab, Wireshark for IPC/WebSocket

### What to measure
- **Wall clock time**: how long the user waits. The only metric that matters for UX.
- **CPU time**: how much work is actually being done. High CPU + low wall clock = parallelizable.
- **Memory**: heap size, retention, leaks. A slow memory leak becomes a crash in production.
- **Frame rate**: for UI, 60fps is the target. Below 30fps feels broken. Dropped frames = jank.
- **Time to Interactive (TTI)**: when can the user actually use the app? Not when did the first pixel appear.

Always measure on the slowest target device, not your dev machine. A MacBook Pro with 32GB RAM hides problems that destroy a 4GB Chromebook.

## Common bottlenecks

### Rendering (React/UI)
- **Too many re-renders.** Every state change re-renders the entire subtree. Use React DevTools Profiler to find components rendering when their props didn't change. Fix with `React.memo`, `useMemo`, or by lifting state.
- **Expensive renders.** A component that does heavy computation during render. Move work to `useMemo`, a web worker, or compute it before setting state.
- **Large lists without virtualization.** Rendering 10,000 rows when only 20 are visible. Use virtual scrolling (react-window, virtuoso).
- **Synchronous layout thrashing.** Reading layout properties (`offsetHeight`, `getBoundingClientRect`) in a loop forces the browser to recalculate layout synchronously. Batch reads, then batch writes.

### Network
- **Waterfall requests.** Sequential dependent requests where each waits for the previous. Parallelize independent requests. Preload known dependencies.
- **Over-fetching.** Downloading 2MB of data when the view only needs 20KB. Add pagination, field selection, or GraphQL.
- **No caching headers.** Re-downloading the same resources every page load. Set `Cache-Control`, use ETags, version assets with hashes.
- **Uncompressed responses.** Gzip/Brotli reduce text payloads by 70-90%. Always on by default in most servers, but verify.

### Bundle size
- **Heavy dependencies.** `moment.js` is 70KB. `date-fns` tree-shakes to 2KB for the functions you use. `lodash` is 70KB; native array methods are 0KB. Always check bundle cost before adding a dependency.
- **Dead code.** Code imported but never used. Tree-shaking catches most, but side-effect imports (`import './styles.css'`) and dynamic patterns (`require(`./${name}`)`) defeat it.
- **Duplicate dependencies.** Two versions of the same library bundled because of version range conflicts. Use `npm ls <package>` or bundle analyzer to find them.
- **Images in JS bundle.** Importing an image into JavaScript inlines it as base64, bloating the bundle. Use URL imports or serve images separately.

### Computation
- **O(n²) on the hot path.** A nested loop that's fine for 10 items that explodes at 10,000. Always test algorithms with production-scale input.
- **Blocking the main thread.** Any synchronous operation over 50ms causes a visible frame drop (jank). Move work to a worker thread, split into chunks with `requestIdleCallback`, or use `scheduler.postTask`.
- **Repeated work.** Computing the same thing for every item when it could be computed once. Hoist loop-invariant computation. Memoize pure functions that are called with the same arguments.
- **Serialization overhead.** `JSON.stringify` on a 10MB object blocks the main thread for hundreds of milliseconds. Use streaming serialization, structured clone, or pass references instead of copies.

## Caching strategies

### When to cache
Cache when: the data is expensive to compute, changes infrequently, and stale data is tolerable for a known window.

Don't cache when: the data is cheap, changes every request, or stale data causes bugs.

### Cache layers (closest to furthest)
1. **In-memory** (Map, WeakMap): sub-millisecond, lost on page refresh. For computed values used multiple times in a render cycle.
2. **Session/local storage**: 5-10MB, persists across refreshes. For user preferences, auth tokens, last-used state.
3. **IndexedDB**: unlimited (user-permitted), async. For structured data, offline support, large datasets.
4. **Service Worker Cache**: for HTTP responses, works offline. For app shell, critical assets.
5. **HTTP cache** (Cache-Control, ETag): browser-managed, transparent. For API responses, static assets.

### Cache invalidation
"There are only two hard things in computer science: cache invalidation and naming things."

Strategies:
- **TTL (Time to Live)**: expire after N seconds. Simplest, good for data that changes predictably.
- **Versioned keys**: `user:${userId}:v2` — new version, new key. Old data is orphaned, not updated.
- **Write-through**: update cache on every write. Cache is always fresh but writes are slower.
- **Stale-while-revalidate**: serve cached data immediately, fetch fresh in background, update next time. Best UX for most cases.

## Rendering performance checklist

- [ ] Use `React.memo` on components that re-render with identical props
- [ ] Use `useMemo` for expensive computations (not everything — memoization has its own cost)
- [ ] Use `useCallback` for callbacks passed to memoized children
- [ ] Virtualize lists over 100 items
- [ ] Avoid creating new objects/arrays in render (they break `React.memo` comparison)
- [ ] Lazy-load below-the-fold components with `React.lazy` + `Suspense`
- [ ] Code-split at route boundaries
- [ ] Use `will-change` CSS sparingly (creates new compositor layers — expensive if overused)
- [ ] Avoid layout thrashing (alternating reads and writes of layout properties)
- [ ] Profile with React DevTools → "Highlight updates when components render"

## Bundle size checklist

- [ ] Run bundle analyzer — know what's in there
- [ ] Replace heavy libraries with lighter alternatives (moment → date-fns, lodash → native)
- [ ] Import only what's used (named imports over default imports for tree-shaking)
- [ ] Dynamic import for non-critical code paths
- [ ] Check for duplicate dependencies with `npm ls` or bundle analyzer
- [ ] Compress images, use modern formats (WebP, AVIF)
- [ ] Enable gzip/Brotli on the server

## Anti-patterns

- **Optimizing without profiling.** "I think this is slow" → profile it. Guessing leads to optimizing the wrong thing.
- **Micro-optimizations that hurt readability.** `for (let i = 0; i < arr.length; i++)` instead of `arr.forEach()` when the difference is 0.001ms. Write for humans first; optimize when the profiler says to.
- **Memoizing everything.** `useMemo` has a cost. Only memoize when the computation is actually expensive or the reference stability matters (passed to memoized children).
- **Premature abstraction for performance.** Building an elaborate caching layer before measuring whether the uncached path is actually slow.
- **Ignoring the critical path.** Optimizing the login page (seen once) instead of the dashboard (seen all day). Profile real user workflows, not synthetic benchmarks.
- **Big rewrites for performance.** "Let's rewrite the whole thing in Rust." No. Profile, find the ONE slow thing, optimize it. 80% of the gain comes from 20% of the code.
