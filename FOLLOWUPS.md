# Runtime follow-ups

Tracking what's done on `feature/runtime-followups` and what remains. The integration-test work is tracked separately in [INTEGRATION-TESTS.md](INTEGRATION-TESTS.md).

## Done on this branch

- [x] **Cross-cycle validation** — new `hasMixedCycle` walks deps and needs together; wired into both [validate.ts](src/planner/validate.ts) and [check-for-loop.ts](src/executer/scheduler/check-for-loop.ts). Tests in [validate.spec.ts](src/planner/validate.spec.ts).
- [x] **Local task pidfile** — [work-runtime-local.ts](src/planner/work-runtime-local.ts) writes `.hammerkit/<id>.pid` for the duration of `execute()`. A live PID (`find-process`) blocks re-entry with an `error` state; a stale PID is silently swept. Tests in [work-runtime-local.spec.ts](src/planner/work-runtime-local.spec.ts).
- [x] **Docker service crash detection** — [docker-service.ts](src/executer/docker-service.ts) now races `container.wait()` against `abort`. A container that exits before abort is reported as `{ type: 'end', reason: 'crash' }` instead of `terminated`.
- [x] **Service env hints for local tasks** — [get-service-env-hints.ts](src/executer/get-service-env-hints.ts) emits `HAMMERKIT_<NAME>_HOST` / `_PORT` / `_PORT_<containerPort>` for each running need. Merged into the local task's command env in [local-task.ts](src/executer/local-task.ts). Tests in [get-service-env-hints.spec.ts](src/executer/get-service-env-hints.spec.ts).
- [x] **K8s deployment healthcheck** — `service.data.healthcheck.cmd` is translated to an `exec` `readinessProbe`/`livenessProbe` in [ensure-kubernetes-deployment-exists.ts](src/kubernetes/ensure-kubernetes-deployment-exists.ts). No more silently-ignored healthchecks on k8s.
- [x] **Kubernetes port-forward without `kubectl`** — [kubernetes-service.ts](src/executer/kubernetes-service.ts) now uses `@kubernetes/client-node`'s `PortForward` class with a local `net.createServer` listener per port. Selector → pod resolution lives in [resolve-pod-name.ts](src/kubernetes/resolve-pod-name.ts) and supports `service`, `deployment`, and `pod` selectors. A new optional `namespace` field on the `kubernetes-service` schema (defaults to `'default'`) makes per-job namespace isolation possible from a build file.

## Done in 1.6.0 hardening (branch `hardening/1.6.0`)

- [x] **Transitive dependency cache invalidation** — `checkCacheState` now folds each task's own state key together with the recursively-computed state keys of its dependencies ([src/executer/scheduler/enqueue-next.ts](src/executer/scheduler/enqueue-next.ts) `combineStateKeys`/`resolveEffectiveStateKey`). A change to an upstream source now invalidates downstream tasks even when their own sources are unchanged. Because `currentStateKey` reads back the stored key, the round-trip stays consistent (one expected cache miss on first run after upgrade). Tests in [enqueue-next.spec.ts](src/executer/scheduler/enqueue-next.spec.ts).
- [x] **K8s stale upload/download pod cleanup** — `getPodForPersistence` force-deletes and waits for any leftover pod of the same name before scheduling a fresh one ([src/kubernetes/ensure-persistent-data.ts](src/kubernetes/ensure-persistent-data.ts) `removeStalePod`), so a pod leaked by a crashed run no longer gets patched in place and stuck. `statusCodeOf` is now shared from [apply.ts](src/kubernetes/apply.ts).

## Open

**Release triage (1.6.0):** none of the items below block the 1.6.0 release — they
are tracked as post-1.6.0 cleanup. They are error-message, code-placement, and
operational-efficiency improvements (no longer any known correctness gap that
yields wrong build outputs).

### Smaller TODOs (lower priority)

- [src/planner/utils/append-work-dependencies.ts:39](src/planner/utils/append-work-dependencies.ts) — `// TODO check if thats correct` (skipping `isFile` generates when inheriting).
- **K8s persistence dedupe + real matcher/stateKey** — [src/kubernetes/ensure-persistent-data.ts](src/kubernetes/ensure-persistent-data.ts) and [src/kubernetes/volumes.ts:89](src/kubernetes/volumes.ts) `:91`. Skipping re-upload when the persisted state already matches needs an in-cluster state marker per volume, and the `matcher: () => true` / `stateKey: ''` placeholders must be replaced with the work item's real source matcher/key. Deferred deliberately: it is a new in-cluster-state feature (not a localized fix) and the k8s persistence path is only exercisable on the self-hosted integration runner, so it was kept out of the release-hardening pass to keep 1.6.0 verifiable. Until then uploads include the full source path (over-upload, still correct).
- [src/schema/reference-parser.ts:276](src/schema/reference-parser.ts) `:305` — generic "unable to find" errors should include resolution path.
- [src/executer/event-cache.ts:15](src/executer/event-cache.ts) `:28` — clean/store logic ought to live in the local runtime, not the cache module.
- [src/executer/state.ts:41](src/executer/state.ts) — emit a warn when removing a listener that isn't registered.
- [src/planner/work-item-status.ts:33](src/planner/work-item-status.ts) `:50` `:58` — `LogContext` should replace with `WorkItem` reference; two `cleanup` markers.
- [src/kubernetes/await-running-state.ts:66](src/kubernetes/await-running-state.ts) — `awaitDeployRunningState` has a confusing `(... && obj.status?.readyReplicas) ?? 0 > 0` operator-precedence expression. It happens to behave correctly (resolves only when `readyReplicas` is truthy) but reads as a bug; rewrite as `((obj.status?.readyReplicas ?? 0) > 0)`. Cosmetic — left untouched in 1.6.0 to avoid changing the k8s path that is only exercised on the integration runner.
