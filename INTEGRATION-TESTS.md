# Hammerkit Integration Test Plan — Self-Hosted Runner

## 1. Goals & Non-Goals

**Goals**
- Move heavy integration tests off GitHub-hosted runners onto a self-hosted Linux host with a real Docker daemon and a persistent Kubernetes cluster.
- Cover cross-runtime scenarios (docker task needing a k8s service, store/restore moving artifacts, the `package` command against a local registry) that the current matrix at [.github/workflows/test.yaml](.github/workflows/test.yaml) cannot.
- Make tests deterministic and parallel-safe via per-job namespacing and label-based cleanup.

**Non-goals**
- Replacing the Windows/macOS legs of `test.yaml`. The windows-2022 leg only sets `WINDOWS_CONTAINERS=true` and stays useful for local-runtime parity; keep it on GitHub-hosted. macOS via colima can drop out once Linux self-hosted covers Docker, but defer that decision.
- Rewriting hammerkit runtime code. Tests only.
- E2E performance benchmarking.

## 2. Self-Hosted Runner Setup

**Host**: a single Linux box (Ubuntu 22.04 or 24.04), labels `[self-hosted, linux, hammerkit]`. One host is enough; concurrency comes from per-job isolation inside it.

**Pre-installed**:
- Docker Engine (rootful, so `dockerode` Unix socket access from CI works the same as [src/executer/docker-task.ts](src/executer/docker-task.ts) expects).
- `k3d` (recommended over kind/minikube: fast cluster create/destroy on top of the same Docker daemon, lets us share images via `k3d image import`). A long-lived `hammerkit-ci` cluster, plus ephemeral per-job clusters when full isolation is needed.
- `kubectl` matching the cluster version; kubeconfig committed as an Actions secret or read from the runner's home.
- Node LTS (match `package.json` engines).
- A persistent `registry:2` container on `localhost:5000` to back the `cli.package({registry: 'localhost:5000', push: true, ...})` flow from [src/docker/package.spec.ts](src/docker/package.spec.ts) — removes the dockerhub credential need.

**GHA wiring** in [.github/workflows/test.yaml](.github/workflows/test.yaml): add a new job `integration` with `runs-on: [self-hosted, linux, hammerkit]`. It runs only the integration spec subset (jest `--testPathPattern src/testing/integration` plus `src/docker/package.spec.ts`). Pass `LINUX_CONTAINERS=true`, `CLUSTER_NAME=hammerkit-ci`, `KUBECONFIG=...`, `REGISTRY=localhost:5000`, and a unique `HAMMERKIT_TEST_RUN_ID=${{ github.run_id }}-${{ github.run_attempt }}` used as a namespace/label suffix.

**Cleanup**: a post-job step that runs `docker container/volume/network prune` filtered by label `hammerkit.dev/id=$HAMMERKIT_TEST_RUN_ID` (the label set across [src/executer/docker-task.ts](src/executer/docker-task.ts), [src/executer/docker-service.ts](src/executer/docker-service.ts), and [src/kubernetes/resources.ts](src/kubernetes/resources.ts)), then `kubectl delete ns -l hammerkit.dev/id=$HAMMERKIT_TEST_RUN_ID`. A nightly cron on the host sweeps anything older than 24h as a safety net.

## 3. Test Scenarios

### Docker-only (`requiresLinuxContainers` today)
- `docker:task-task-volume` — task A `generates` artifact mounted as `src` of task B; assert cache hit on rerun. (Net-new; partially covered by `store.spec.ts`.)
- `docker:task-needs-service` — already in `services.spec.ts`; reframe as `createTestCase` for consistency.
- `docker:service-healthcheck-gate` — task waits for service `healthcheck` before running ([src/planner/work-healthcheck.ts](src/planner/work-healthcheck.ts)). Net-new.
- `docker:package-local-registry` — adapt second test in [src/docker/package.spec.ts](src/docker/package.spec.ts) to push to host registry; assert image exists via registry HTTP API. Partially covered.
- `docker:store-restore-roundtrip` — covered by `store.spec.ts`; keep, port to `createTestCase`.

### Kubernetes-only (`requiresKubernetes`)
- `k8s:deployment-up-down` — extend `kubernetes.spec.ts` to actually assert deployment, service, ingress objects ([src/kubernetes/ensure-*.ts](src/kubernetes/)). Currently only calls `runUp`.
- `k8s:pvc-store-restore` — store and restore artifacts living on a PVC ([src/kubernetes/store-kubernetes-data.ts](src/kubernetes/store-kubernetes-data.ts), [restore-kubernetes-data.ts](src/kubernetes/restore-kubernetes-data.ts)). Net-new.
- `k8s:current-state-key-cache` — verify the `currentStateKey` caching from `feature/shared-services` (commit `1540322`): rerun yields `cached: true`. Net-new.
- `k8s:ingress` — `ensureIngress` creates and reuses a host rule across reruns. Net-new.

### Cross-runtime
- `cross:docker-vs-k8s-equivalence` — same `.hammerkit.yaml` run with `environments.default.kubernetes` vs unset; assert task output equivalence. Net-new.
- `cross:k8s-service-forward-into-docker-task` — exercises `kubernetesForwardRuntime` (port-forward k8s service into a docker task's network). Net-new and the riskiest one — gate behind P2.
- `cross:package-mixed-tree` — `cli.package` over a work tree mixing docker tasks and k8s service descriptors; verify only docker-runnable items end up as images.

## 4. Test Infrastructure Changes

- **Gates**: keep `requiresLinuxContainers`/`requiresKubernetes` (used by other CI legs), but add a `HAMMERKIT_FULL_INTEGRATION=true` env that makes them assert-on-missing instead of no-op, so the self-hosted job fails fast if Docker/k8s drop out instead of silently skipping (today's behavior in [src/testing/requires-kubernetes.ts:4](src/testing/requires-kubernetes.ts)).
- **Layout**: keep specs under [src/testing/integration/](src/testing/integration/) (avoids a parallel `tsconfig`/`jest` config), but introduce a `testRegex` switch via env or a second `jest.integration.config.ts` extending the base with a longer `testTimeout` (~300s) and disabling coverage. The default [jest.config.ts](jest.config.ts) already pins `maxConcurrency: 1`; the integration config can raise this once isolation lands.
- **Local registry**: add a tiny helper `ensureLocalRegistry()` that no-ops if `REGISTRY=localhost:5000` is reachable, used by package tests instead of the inline `registry:2` service in [src/docker/package.spec.ts](src/docker/package.spec.ts).
- **Parallel isolation**: thread `HAMMERKIT_TEST_RUN_ID` through `createTestCase` so every Docker resource carries `hammerkit.dev/id=<run-id>-<spec>` and every k8s object lands in `ns-<run-id>-<spec>`. This requires a small extension to `Environment.processEnvs` plumbing in [src/testing/test-case.ts](src/testing/test-case.ts) — no runtime code changes.

## 5. Phased Delivery

**P0 — runner online, parity**
- Provision the host, install Docker + k3d + registry, register the runner.
- Add `integration` job in `test.yaml`, run the existing `requiresLinuxContainers`/`requiresKubernetes` specs unchanged.
- Add label-based post-job cleanup. Deliverable: green build, no new specs.

**P1 — consolidation + first net-new**
- Port `docker.spec.ts`, `services.spec.ts`, `store.spec.ts` from `ExampleTestSuite` ([src/testing/example-test-suite.ts](src/testing/example-test-suite.ts)) to `createTestCase` for consistency.
- Land `docker:package-local-registry`, `k8s:current-state-key-cache`, `k8s:pvc-store-restore`.
- Introduce `HAMMERKIT_TEST_RUN_ID` plumbing and namespace-per-spec.

**P2 — cross-runtime**
- `cross:docker-vs-k8s-equivalence`, `cross:package-mixed-tree`.
- `cross:k8s-service-forward-into-docker-task` last — depends on `kubernetesForwardRuntime` stability (see [FOLLOWUPS.md](FOLLOWUPS.md) item on kubectl migration).
- Optionally retire the macOS leg of `test.yaml` once Linux self-hosted has been stable for ~2 weeks.

## 6. Open Questions

- Single self-hosted host or a small pool? A pool lets us drop `maxConcurrency: 1`, but isolation work in P1 has to land first.
- Long-lived `hammerkit-ci` k3d cluster vs cluster-per-job? Long-lived is faster but accumulates state; per-job is cleaner but ~30s slower per run.
- Keep `windows-2022` and `macos-12` legs in `test.yaml`, or trim once Linux self-hosted proves out? Windows currently only exercises local runtime (`WINDOWS_CONTAINERS=true`) — confirm that's still in scope.
- Are dockerhub credentials still needed once `localhost:5000` is in place, or do any tests still pull rate-limited images that would benefit from authenticated pulls?
- Should `requiresKubernetes` get an opt-in `HAMMERKIT_FULL_INTEGRATION` mode that turns "missing cluster" from skip into hard failure, as proposed in section 4?
