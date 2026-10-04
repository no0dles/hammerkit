# Feature Specification: Skip Dependencies of Cached Tasks

**Feature Branch**: `feat/1.7-agent-ready`

**Created**: 2026-09-30

**Status**: Implemented (1.7.0)

**Input**: Pilot of the agent/CI cache flow — CI pulled the cached result of an e2e job an agent ran, the e2e task was a cache hit, yet its `build` and `install` dependencies still executed because their own results were not available. Running a dependency whose output nothing in the run consumes is pure waste.

## Behavior

- A task that was **requested** (named on the command line, or selected by a label filter) always runs or restores from the cache.
- A task pulled in **only as a dependency** waits until a task depending on it is `ready` — it missed the cache and is about to run. Then the dependency runs normally. If every dependent finishes without needing it (all cache hits, or skipped themselves), the dependency completes as **skipped** without running.
- Decisions are made lazily from the dependents' actual cache outcome, never predicted up front, so a predicted hit that turns into a miss (e.g. a failed restore) still gets its dependencies.
- A service's dependency counts the service as its dependent: it runs once the service is `starting` (a task needing it runs), and is skipped when the service ends without starting (1.11.2). A dependency whose dependents are all outside the run is skipped.
- Always run (no skipping): everything in watch mode, `up`/`down`, and everything with `--no-skip-deps`.
- A skipped task is a successful completion (`completed` with `skipped: true`), reported as `skipped` in the build summary and `[SKIPPED]` in logs.

## Decision

On by default, with `--no-skip-deps` to opt out (user decision, 2026-09-30). This is a behavior change: a skipped dependency leaves no outputs in the workspace (e.g. an exported `dist`), which is why the opt-out exists.

## Tests

`src/executer/skip-deps.spec.ts`: skipped when the dependent is cached; `--no-skip-deps` runs everything; a dependent miss runs its dependencies; requested tasks always run. `src/testing/integration/service-deps-skip.spec.ts`: a service's dependency runs when the service starts and is skipped when the task needing the service is cached.
