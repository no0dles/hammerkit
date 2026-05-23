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
