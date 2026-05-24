# Runtime follow-ups

Tracking what's done on `feature/runtime-followups` and what remains. The integration-test work is tracked separately in [INTEGRATION-TESTS.md](INTEGRATION-TESTS.md).

## Done on this branch

- [x] **Cross-cycle validation** — new `hasMixedCycle` walks deps and needs together; wired into both [validate.ts](src/planner/validate.ts) and [check-for-loop.ts](src/executer/scheduler/check-for-loop.ts). Tests in [validate.spec.ts](src/planner/validate.spec.ts).
- [x] **Local task pidfile** — [work-runtime-local.ts](src/planner/work-runtime-local.ts) writes `.hammerkit/<id>.pid` for the duration of `execute()`. A live PID (`find-process`) blocks re-entry with an `error` state; a stale PID is silently swept. Tests in [work-runtime-local.spec.ts](src/planner/work-runtime-local.spec.ts).
- [x] **Docker service crash detection** — [docker-service.ts](src/executer/docker-service.ts) now races `container.wait()` against `abort`. A container that exits before abort is reported as `{ type: 'end', reason: 'crash' }` instead of `terminated`.
- [x] **Service env hints for local tasks** — [get-service-env-hints.ts](src/executer/get-service-env-hints.ts) emits `HAMMERKIT_<NAME>_HOST` / `_PORT` / `_PORT_<containerPort>` for each running need. Merged into the local task's command env in [local-task.ts](src/executer/local-task.ts). Tests in [get-service-env-hints.spec.ts](src/executer/get-service-env-hints.spec.ts).
- [x] **K8s deployment healthcheck** — `service.data.healthcheck.cmd` is translated to an `exec` `readinessProbe`/`livenessProbe` in [ensure-kubernetes-deployment-exists.ts](src/kubernetes/ensure-kubernetes-deployment-exists.ts). No more silently-ignored healthchecks on k8s.
- [x] **Kubernetes port-forward without `kubectl`** — [kubernetes-service.ts](src/executer/kubernetes-service.ts) now uses `@kubernetes/client-node`'s `PortForward` class with a local `net.createServer` listener per port. Selector → pod resolution lives in [resolve-pod-name.ts](src/kubernetes/resolve-pod-name.ts) and supports `service`, `deployment`, and `pod` selectors. A new optional `namespace` field on the `kubernetes-service` schema (defaults to `'default'`) makes per-job namespace isolation possible from a build file.

## Open

**Release triage (1.6.0):** none of the items below block the 1.6.0 release — they
are tracked as post-1.6.0 cleanup. Two are worth prioritizing next because they
affect correctness rather than polish: the `task-state` transitive dep state-keys
(cache can fail to invalidate transitively) and the `ensure-persistent-data`
cleanup/dedupe (leaks old upload pods / re-uploads existing state). The rest are
error-message and code-placement improvements.

### Smaller TODOs (lower priority)

- [src/planner/utils/append-work-dependencies.ts:39](src/planner/utils/append-work-dependencies.ts) — `// TODO check if thats correct` (skipping `isFile` generates when inheriting).
- [src/kubernetes/ensure-persistent-data.ts:31](src/kubernetes/ensure-persistent-data.ts) `:98` `:109` — pending cleanup of old upload pods, dedupe of already-uploaded state, file-exists guard.
- [src/kubernetes/volumes.ts:39](src/kubernetes/volumes.ts) `:89` `:91` — placeholder matchers and empty stateKey.
- [src/schema/reference-parser.ts:276](src/schema/reference-parser.ts) `:305` — generic "unable to find" errors should include resolution path.
- [src/executer/event-cache.ts:15](src/executer/event-cache.ts) `:28` — clean/store logic ought to live in the local runtime, not the cache module.
- [src/executer/scheduler/task-state.ts:5](src/executer/scheduler/task-state.ts) — task-state should include dep state-keys so cache invalidates transitively.
- [src/executer/state.ts:41](src/executer/state.ts) — emit a warn when removing a listener that isn't registered.
- [src/planner/work-item-status.ts:33](src/planner/work-item-status.ts) `:50` `:58` — `LogContext` should replace with `WorkItem` reference; two `cleanup` markers.
