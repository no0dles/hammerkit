# Runtime follow-ups

Open items surfaced while finishing `feature/shared-services` (PR #6). Each is independent — pick in any order.

## 1. Cross-cycle validation (`task → dep → service → need → task`)

**Where:** [src/planner/validate.ts:77](src/planner/validate.ts) TODO comment.

`hasDependencyCycle` walks `deps`, `hasNeedCycle` walks `needs`. A chain that alternates the two (e.g. task A `deps` service B which `needs` service C which has a task `dep` back to A) is not detected. Write a unified walker that follows both edge types and update [src/executer/scheduler/check-for-loop.ts](src/executer/scheduler/check-for-loop.ts) to use it. Coverage: add cases to [src/planner/validate.spec.ts](src/planner/validate.spec.ts) with mixed dep/need chains.

## 2. Migrate `kubernetesForwardRuntime` away from `kubectl`

**Where:** [src/planner/work-runtime-kubernetes.ts:283](src/planner/work-runtime-kubernetes.ts) (`TODO migrate away from kubectl`).

`kubernetesForwardRuntime.execute` calls `kubernetesService(...)` which shells out to `kubectl port-forward`. Replace with the in-process `@kubernetes/client-node` port-forward API so hammerkit doesn't require `kubectl` on PATH. The implementation lives in [src/executer/kubernetes-service.ts](src/executer/kubernetes-service.ts).

## 3. Local task runtime: detect concurrent runs

**Where:** [src/planner/work-runtime-local.ts:18](src/planner/work-runtime-local.ts) and [:32](src/planner/work-runtime-local.ts) (both `TODO check for running tasks`).

`initialize()` and `stop()` are no-ops. If a previous hammerkit invocation crashed mid-task, there's no PID/lockfile tracking and a re-run can race. Suggestion: write a pidfile next to the state file under `.hammerkit/<id>.pid`, and on `initialize` use `find-process` (already a dependency) to detect a live PID.

## 4. Service crash detection while running

**Where:** [src/executer/docker-service.ts:106](src/executer/docker-service.ts) (`TODO check if container crashes`).

After `dockerService` marks the service `running`, it `waitOnAbort` — but a container that crashes mid-run isn't surfaced. Attach a watcher on `container.wait()` and flip state to `{ type: 'end', reason: 'crash' }` if it exits before abort.

## 5. Kubernetes deployment healthcheck

**Where:** [src/kubernetes/ensure-kubernetes-deployment-exists.ts:78](src/kubernetes/ensure-kubernetes-deployment-exists.ts) (`TODO healthcheck`).

`service.data.healthcheck` is ignored when building the Deployment spec. Translate it into a `readinessProbe`/`livenessProbe` (exec or http) — see how [src/executer/check-readiness.ts](src/executer/check-readiness.ts) interprets the same data for docker.

## 6. Service env-var hints for local tasks

**Where:** [src/executer/local-task.ts](src/executer/local-task.ts).

A local task that has `needs: [postgres]` has no way to know that the postgres service is reachable on `127.0.0.1:<hostPort>`. The docker-task path injects `Links`/`ExtraHosts`; the local path injects nothing. Suggestion: inject env vars like `HAMMERKIT_<UPPER_NAME>_HOST=127.0.0.1` and `_PORT=<hostPort>` for each running need, derived from `item.needs` + the service's `ports`.

## 7. Other small TODOs

Lower priority, listed for completeness:

- [src/planner/utils/append-work-dependencies.ts:39](src/planner/utils/append-work-dependencies.ts) — `// TODO check if thats correct` (skipping `isFile` generates when inheriting).
- [src/kubernetes/ensure-persistent-data.ts:31](src/kubernetes/ensure-persistent-data.ts) `:98` `:109` — pending cleanup of old upload pods, dedupe of already-uploaded state, file-exists guard.
- [src/kubernetes/volumes.ts:39](src/kubernetes/volumes.ts) `:89` `:91` — placeholder matchers and empty stateKey.
- [src/schema/reference-parser.ts:276](src/schema/reference-parser.ts) `:305` — generic "unable to find" errors should include resolution path.
- [src/executer/event-cache.ts:15](src/executer/event-cache.ts) `:28` — clean/store logic ought to live in the local runtime, not the cache module.
- [src/executer/scheduler/task-state.ts:5](src/executer/scheduler/task-state.ts) — task-state should include dep state-keys so cache invalidates transitively.
- [src/executer/state.ts:41](src/executer/state.ts) — emit a warn when removing a listener that isn't registered.
- [src/planner/work-item-status.ts:33](src/planner/work-item-status.ts) `:50` `:58` — `LogContext` should replace with `WorkItem` reference; two `cleanup` markers.
