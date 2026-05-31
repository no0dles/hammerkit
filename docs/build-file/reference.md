---
description: Every key the build-file schema accepts.
---

# Build file reference

This is the complete reference for the hammerkit build file, derived from the
schema hammerkit validates against (`build.schema.json`). Unknown keys are
rejected, so this list is exhaustive. For prose and examples, follow the links to
the dedicated pages.

## Top-level keys

| Key | Type | Description |
|-----|------|-------------|
| `envs` | map of string→string/number | Build-file-wide [environment variables](environment-variables.md). |
| `tasks` | map of name→task | The [tasks](../task/README.md) in this file. |
| `services` | map of name→service | The [services](../service/README.md) in this file. |
| `references` | map of prefix→path | [Reference](references.md) other build files (keep their own directory). |
| `includes` | map of prefix→path | [Include](includes.md) other build files (use this file's directory). |
| `environments` | map of name→environment | [Run targets](../task/kubernetes.md) (Kubernetes or remote Docker). |
| `caches` | map of name→cache | Named [cache](caches.md) declarations (method + backend). |
| `labels` | map of string→string/number | [Labels](../labels/README.md) applied to every task/service in the file. |

## Task

A task is either a **container task** (it has an `image`) or a **local task** (no
`image`). Both share these fields:

| Field | Type | Description |
|-------|------|-------------|
| `cmds` | array of string \| `{cmd, path}` | Commands to run, in order. `path` sets the working directory for that command. |
| `description` | string | Shown by [`ls`](../cli/ls.md); a missing one is a [validate](../cli/validate.md) warning. |
| `src` | array of string | Input files/folders/globs used for [caching](../task/caching.md). |
| `generates` | array of string \| `{path, export, resetOnChange, name}` | [Output](../task/README.md#generated-files-generates) paths. `export: true` copies back to the workspace; `resetOnChange: true` wipes it before a re-run. |
| `deps` | array of string | [Tasks](../task/dependencies.md) (`name` or `prefix:name`) that run first. |
| `needs` | array of string \| `{service, name}` | [Services](../task/needs.md) that must be ready first. |
| `envs` | map of string→string/number | Task-level [environment variables](environment-variables.md) (override build-file `envs`). |
| `labels` | map of string→string/number | [Labels](../labels/README.md) for filtering. |
| `cache` | string \| `{name, method}` | [Cache](../task/caching.md) method shorthand or a named cache reference. |
| `extend` | string | [Base task](../task/extending.md) to inherit from (`prefix:name`). |
| `shell` | string | Shell used to run `cmds` (default `/bin/sh`). |
| `continuous` | boolean | Task [watches itself](../task/watching.md); hammerkit won't restart it in watch mode. |

**Container task** adds:

| Field | Type | Description |
|-------|------|-------------|
| `image` | string (required) | The container image to run in. Its presence is what makes the task containerized. |
| `mounts` | array of string | Extra `host[:container]` [mounts](../task/container.md#adding-mounts). |

**Local task** adds:

| Field | Type | Description |
|-------|------|-------------|
| `platform` | `{os, arch}` | Restrict to `os` (`win`/`macos`/`linux`) and/or `arch` (`arm64`/`arm`). |

## Service

A service is either a **container service** (it has an `image`) or a **Kubernetes
service** (it has a `selector`).

**Container service:**

| Field | Type | Description |
|-------|------|-------------|
| `image` | string (required) | The service image. |
| `cmd` | string | Override the container command. |
| `ports` | array of string/number | `containerPort` or `hostPort:containerPort` to publish to the host. |
| `healthcheck` | `{cmd}` | Readiness command; see [healthcheck](../service/container.md#healthcheck). |
| `envs` | map of string→string/number | Service environment variables. |
| `volumes` | array of string | `name:containerPath` volumes that [persist](../service/container.md#volumes) across restarts. |
| `mounts` | array of string | `host:container` config mounts. |
| `deps` | array of string | Tasks that must run before the service starts. |
| `needs` | array of string \| `{service, name}` | Other services this one depends on. |
| `src` | array of string | Sources, used for caching the service image build. |
| `labels` | map of string→string/number | Labels for filtering. |
| `description` | string | Description shown by `ls`. |
| `continuous` | boolean | Long-running service (the usual case). |

**Kubernetes service** (forwards an existing cluster resource — see
[Kubernetes service](../service/kubernetes.md)):

| Field | Type | Description |
|-------|------|-------------|
| `selector` | `{type, name}` (required) | Resource `type` (`deployment`/`service`/`pod`) and `name` to forward. |
| `ports` | array of string/number (required) | `hostPort:containerPort` mappings to forward to localhost. |
| `context` | string | Override the environment's kube context. |
| `namespace` | string | Override the environment's namespace. |
| `kubeconfig` | string | Override the environment's kubeconfig path. |
| `deps` | array of string | Tasks that run before forwarding. |
| `labels` / `description` | – | As above. |

## Cache (`caches`)

Each named cache has a `method` and a `backend` (see [caches](caches.md)):

| Field | Type | Description |
|-------|------|-------------|
| `method` | `checksum` \| `modify-date` \| `none` | How changes are detected. |
| `backend.type` | `local` \| `s3` | Where results are stored. |
| `backend.path` | string (`local`) | Directory; defaults to `~/.hammerkit/remote-cache`. |
| `backend.bucket` | string (`s3`, required) | Target bucket. |
| `backend.region` / `endpoint` / `prefix` / `forcePathStyle` | – (`s3`) | S3 connection options. |

A task's `cache` field is either the method shorthand (`cache: checksum`) or a
reference `{name, method}` to a declared cache.

## Environment (`environments`)

Each environment is a [run target](../task/kubernetes.md) — exactly one of:

| Key | Fields | Description |
|-----|--------|-------------|
| `kubernetes` | `context` (required), `namespace`, `kubeconfig`, `ingresses[]` | Run tasks as jobs and services as deployments on a cluster. |
| `docker` | `host` | Run against a remote Docker daemon. |

An `ingresses` entry has `kind` (`ingress`/`httproute`), `host`, `service`,
`servicePort`, `path`, `gateway`, `gatewayNamespace` — see
[ingresses](../task/kubernetes.md#ingresses).
