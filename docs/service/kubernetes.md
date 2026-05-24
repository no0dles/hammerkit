# Kubernetes service
Kubernetes services can be used to access resources from kubernetes clusters in your tasks.
Allowing to share resources on a remote machine or run tasks against test/staging/production environments.

{% hint style="info" %}
To run your own tasks and services **on** a cluster instead of forwarding existing
resources, see [running on Kubernetes](../task/kubernetes.md).
{% endhint %}

## Config
Hammerkit uses by default the standard kubernetes configuration in the `$home/.kube/config` file. 
The `kubeconfig` value allows the usage of another config file. 
The optional `namespace` value selects the namespace the resource is looked up in.

```yaml
services:
  postgres:
    context: docker-desktop
    namespace: databases
    kubeconfig: ./kube-config.yaml
```

{% hint style="info" %}
Port-forwarding no longer requires the `kubectl` binary to be installed. Hammerkit
forwards ports directly through the kubernetes client.
{% endhint %}

## Context / Selector
The context specifies which cluster and user will be used to forward ports.
The selector contains the resource type and name to forward from.

```yaml
services:
  postgres:
    context: docker-desktop
    ports:
      - 5432:5432
    selector:
      type: deployment
      name: postgres
```

Possible selector types could be `deployment`, `service` or `pod`.

## Cluster providers

Hammerkit talks to a cluster through your kubeconfig, so every provider works the
same way - the only difference is the `context` name (and optionally a dedicated
`kubeconfig` file). The context is whatever the provider's auth tooling writes into
your kubeconfig.

### GKE (Google Kubernetes Engine)

`gcloud container clusters get-credentials <cluster>` writes a context named
`gke_<project>_<location>_<cluster>`:

```yaml
services:
  postgres:
    context: gke_my-project_europe-west1_my-cluster
    namespace: databases
    ports:
      - 5432:5432
    selector:
      type: deployment
      name: postgres
```

### EKS (Amazon)

`aws eks update-kubeconfig --name <cluster>` writes an ARN-style context:

```yaml
services:
  postgres:
    context: arn:aws:eks:eu-central-1:123456789012:cluster/my-cluster
    namespace: databases
    ports:
      - 5432:5432
    selector:
      type: service
      name: postgres
```

### AKS (Azure)

`az aks get-credentials --name <cluster>` writes a context named after the cluster.
Point `kubeconfig` at a dedicated file when you don't want to use the default one
(for example a kubeconfig provided by CI):

```yaml
services:
  postgres:
    context: my-cluster
    kubeconfig: ./aks-config.yaml
    namespace: databases
    ports:
      - 5432:5432
    selector:
      type: deployment
      name: postgres
```
