---
description: >-
  Run your tasks and services on a Kubernetes cluster instead of the local docker
  daemon by selecting an environment.
---

# Running on Kubernetes

Since `1.6.0` hammerkit can execute the same build file either on the local docker
daemon or on a Kubernetes cluster. This is done through an **environment**: tasks
run as jobs on the cluster, container services run as deployments, and the result
of each task is cached the same way as locally.

{% hint style="info" %}
This is different from [Kubernetes services](../service/kubernetes.md), which only
forward existing resources from a cluster into a local task. Here your own tasks
and services run on the cluster.
{% endhint %}

## Declaring an environment

Environments are declared in a top-level `environments:` block. Each environment
targets either `kubernetes` or `docker`.

{% code title=".hammerkit.yaml" %}
```yaml
environments:
  default:
    kubernetes:
      context: docker-desktop

services:
  postgres:
    image: postgres:12-alpine
    envs:
      POSTGRES_USER: postgres
      POSTGRES_DB: demo
      POSTGRES_PASSWORD: 123456
    ports:
      - 5432:5432
    healthcheck:
      cmd: "pg_isready -U postgres"

tasks:
  api:
    image: node:16.6.0-alpine
    needs: [postgres]
    cmds:
      - node index.js
```
{% endcode %}

### Kubernetes target

| Field        | Required | Description                                                              |
|--------------|----------|--------------------------------------------------------------------------|
| `context`    | yes      | The kube context (cluster + user) the tasks run in.                       |
| `namespace`  | no       | Namespace the jobs and deployments are created in.                        |
| `kubeconfig` | no       | Path to a kubeconfig file. Defaults to `$HOME/.kube/config`.              |
| `ingresses`  | no       | Ingress / Gateway API route definitions to expose services, see [ingresses](#ingresses). |

{% hint style="info" %}
The same `context`, `kubeconfig` and `namespace` also supply the cluster connection
for port-forward [Kubernetes services](../service/kubernetes.md): declare the cluster
once here and select it with `--env`, rather than repeating it on each service.
{% endhint %}

### Docker target

| Field  | Required | Description                                       |
|--------|----------|---------------------------------------------------|
| `host` | no       | Address of a remote docker daemon to run against. |

## Selecting an environment

Pass `--env <name>` to run against a declared environment. Without it, hammerkit
uses the local docker daemon.

```bash
hammerkit api --env default
```

The `--env` option is available on the execute, [store and restore](../cli/store-restore.md)
commands, so cache results can be stored from and restored to a cluster.

## Healthchecks

A container service [healthcheck](../service/container.md#healthcheck) is
translated into readiness and liveness probes on the Kubernetes deployment, so
dependent tasks only start once the service is ready.

## Ingresses

Ingresses expose a service of the environment under a hostname, for example to
reach a deployed application from outside the cluster.

```yaml
environments:
  staging:
    kubernetes:
      context: staging-cluster
      namespace: my-app
      ingresses:
        - host: api.example.com
          service: api
          servicePort: 3000
          path: /
```

| Field              | Required        | Description                                                   |
|--------------------|-----------------|---------------------------------------------------------------|
| `kind`             | no              | `ingress` (default) or `httproute` for the Gateway API.       |
| `host`             | yes             | Hostname the route responds to.                               |
| `service`          | yes             | Name of the service to route to.                              |
| `servicePort`      | no              | Port of the service to route to.                              |
| `path`             | no              | Path prefix that is routed to the service.                    |
| `gateway`          | for `httproute` | Name of the parent `Gateway` (Gateway API only).              |
| `gatewayNamespace` | no              | Namespace of the parent `Gateway`, if not the route's own.    |

### Gateway API

Set `kind: httproute` on an entry to create a Gateway API
[`HTTPRoute`](https://gateway-api.sigs.k8s.io/) instead of an Ingress. The Gateway
API is the modern replacement for Ingress: rather than relying on an ingress
controller, an `httproute` attaches to a parent `gateway`. Both `ingress` and
`httproute` entries can be mixed in the same `ingresses` list.

```yaml
environments:
  staging:
    kubernetes:
      context: staging-cluster
      namespace: my-app
      ingresses:
        - kind: httproute
          host: api.example.com
          service: api
          servicePort: 3000
          path: /
          gateway: web                 # parent Gateway in this namespace
          # gatewayNamespace: gateways # set if the Gateway lives elsewhere
```

{% hint style="info" %}
This requires the [Gateway API CRDs](https://gateway-api.sigs.k8s.io/guides/) and a
`Gateway` resource to be installed in the cluster.
{% endhint %}
