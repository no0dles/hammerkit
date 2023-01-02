# Kubernetes service
Kubernetes services can be used to access resources from kubernetes clusters in your tasks.
Allowing to share resources on a remote machine or run tasks against test/staging/production environments.

## Config
Hammerkit uses by default the standard kubernetes configuration in the `$home/.kube/config` file. 
The `kubeconfig` value allows the usage of another config file. 

```yaml
services:
  postgres:
    context: docker-desktop
    kubeconfig: ./kube-config.yaml
```

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
