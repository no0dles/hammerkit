# Kubernetes service
Kubernetes services can be used to access resources from kubernetes clusters in your tasks.
Allowing to share resources on a remote machine or run tasks against test/staging/production environments.

{% hint style="info" %}
To run your own tasks and services **on** a cluster instead of forwarding existing
resources, see [running on Kubernetes](../task/kubernetes.md).
{% endhint %}

## Cluster config lives in the environment

The cluster connection — `context`, `kubeconfig` and the default `namespace` — is
declared once in an [environment](../task/kubernetes.md#declaring-an-environment),
not on every service. A Kubernetes service then only needs the `selector` and the
`ports` to forward, and is pointed at a cluster by selecting an environment with
`--env`.

{% code title=".hammerkit.yaml" %}
```yaml
environments:
  local:
    kubernetes:
      context: docker-desktop
  prod:
    kubernetes:
      context: gke_my-project_europe-west1_my-cluster
      kubeconfig: ./prod-kube.yaml
      namespace: databases

services:
  postgres:
    ports:
      - 5432:5432
    selector:
      type: deployment
      name: postgres
```
{% endcode %}

```bash
hammerkit my-task --env prod   # forwards postgres from the prod cluster
hammerkit my-task --env local  # same service, local cluster
```

The same build file now targets dev/prod/local clusters without repeating the
cluster wiring on each service. When an environment named `default` exists it is
used without passing `--env`.

{% hint style="info" %}
Port-forwarding no longer requires the `kubectl` binary to be installed. Hammerkit
forwards ports directly through the kubernetes client.
{% endhint %}

## Service fields

| Field        | Required | Description                                                                                  |
|--------------|----------|----------------------------------------------------------------------------------------------|
| `selector`   | yes      | Resource `type` (`deployment`, `service` or `pod`) and `name` to forward from.               |
| `ports`      | yes      | Port mappings (`hostPort:containerPort`) to forward to localhost.                             |
| `namespace`  | no       | Overrides the environment namespace; defaults to the environment's, then `default`.          |
| `context`    | no       | Overrides the environment context. Rarely needed — prefer the environment.                   |
| `kubeconfig` | no       | Overrides the environment kubeconfig. Defaults to the environment's, then `$HOME/.kube/config`. |

## Overriding per service

A service can override the inherited namespace (or, for a mixed-cluster setup, the
context/kubeconfig) while still picking up the rest from the environment:

```yaml
environments:
  prod:
    kubernetes:
      context: gke_my-project_europe-west1_my-cluster
      namespace: databases

services:
  postgres:
    namespace: orders        # override just the namespace
    ports:
      - 5432:5432
    selector:
      type: deployment
      name: postgres
```

## Cluster providers

Hammerkit talks to a cluster through your kubeconfig, so every provider works the
same way — the only difference is the `context` name (and optionally a dedicated
`kubeconfig` file). The context is whatever the provider's auth tooling writes into
your kubeconfig. Put it in the environment once; services stay provider-agnostic.

### GKE (Google Kubernetes Engine)

`gcloud container clusters get-credentials <cluster>` writes a context named
`gke_<project>_<location>_<cluster>`:

```yaml
environments:
  prod:
    kubernetes:
      context: gke_my-project_europe-west1_my-cluster
      namespace: databases
```

### EKS (Amazon)

`aws eks update-kubeconfig --name <cluster>` writes an ARN-style context:

```yaml
environments:
  prod:
    kubernetes:
      context: arn:aws:eks:eu-central-1:123456789012:cluster/my-cluster
      namespace: databases
```

### AKS (Azure)

`az aks get-credentials --name <cluster>` writes a context named after the cluster.
Point `kubeconfig` at a dedicated file when you don't want to use the default one
(for example a kubeconfig provided by CI):

```yaml
environments:
  prod:
    kubernetes:
      context: my-cluster
      kubeconfig: ./aks-config.yaml
      namespace: databases
```

With the cluster declared in the environment, the same service definition works
across all of them:

```yaml
services:
  postgres:
    ports:
      - 5432:5432
    selector:
      type: deployment
      name: postgres
```
