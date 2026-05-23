# Self-hosted integration-test runner

The integration test job ([.github/workflows/integration.yaml](../../.github/workflows/integration.yaml)) targets a self-hosted Linux runner labeled `[self-hosted, linux, hammerkit]`. It expects a single host, one long-lived k3d cluster, and namespace-per-job isolation.

## Host requirements

Ubuntu 22.04 or 24.04. Install:

- **Docker Engine** (rootful). The runner connects via the local socket; no special config.
- **Node 20**. Matches the `actions/setup-node@v4` step.
- **kubectl** matching the k3d cluster version.
- **k3d** (`curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash`).

## Long-lived cluster

Create the cluster once:

```sh
k3d cluster create hammerkit-ci \
  --servers 1 --agents 1 \
  --port "30000-30100:30000-30100@server:0" \
  --wait
kubectl config use-context k3d-hammerkit-ci
```

The workflow expects `CLUSTER_NAME=hammerkit-ci` and reads `KUBECONFIG=/home/runner/.kube/config`. The cluster persists across jobs.

## Per-job isolation

Every job exports `HAMMERKIT_TEST_RUN_ID=<run_id>-<run_attempt>`. The workflow:

1. Creates a fresh namespace `hammerkit-<run-id>` labeled `hammerkit.dev/run-id=<run-id>`.
2. Threads the same id into hammerkit's container labels via `createTestCase` in [src/testing/test-case.ts](../../src/testing/test-case.ts) (the test process picks it up from `process.env.HAMMERKIT_TEST_RUN_ID`).
3. After the run (success or failure):
   - Removes every docker resource carrying a `hammerkit-id` label.
   - Deletes the namespace by label selector.

Tests reference the namespace via build-file templating, e.g.:

```yaml
environments:
  default:
    kubernetes:
      namespace: $KUBE_NAMESPACE
      context: hammerkit-ci
```

The workflow exports `KUBE_NAMESPACE=hammerkit-${HAMMERKIT_TEST_RUN_ID}`.

## Local registry

A long-lived `registry:2` container on `localhost:5000` backs the `cli.package` push tests. Start it once on the host:

```sh
docker run -d --restart=always --name hammerkit-registry \
  -p 5000:5000 registry:2
```

Tests pick it up via `REGISTRY=localhost:5000` (see [src/testing/ensure-local-registry.ts](../../src/testing/ensure-local-registry.ts)). If `REGISTRY` is unset, the helper falls back to managing its own ephemeral registry container — useful locally, but slower.

## Failure mode

When `HAMMERKIT_FULL_INTEGRATION=true` (always on in CI), the three `requires-*` gates fail the test instead of silently skipping when their env vars are missing. This guarantees a missing Docker or cluster surfaces as a red build, not a green skip.

## Nightly safety-net cleanup

Anything older than 24h that escapes per-job cleanup is swept by a cron on the host. Recommended:

```sh
# /etc/cron.daily/hammerkit-sweep
docker container prune -f --filter "until=24h" --filter "label=hammerkit-id" >/dev/null
docker volume  prune  -f --filter "label=hammerkit-id" >/dev/null
kubectl --context hammerkit-ci get ns -l hammerkit.dev/run-id \
  -o jsonpath='{range .items[?(@.metadata.creationTimestamp<"-24h")]}{.metadata.name}{"\n"}{end}' \
  | xargs -r kubectl --context hammerkit-ci delete ns
```
