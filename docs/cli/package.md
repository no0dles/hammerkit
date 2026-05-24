---
description: >-
  Bake your services and their build dependencies into self-contained docker
  images and push them to a registry.
---

# Package

The `package` command turns the **container services** of your build file into
docker images. For each service hammerkit builds a multi-stage image that bakes
in the service itself plus the outputs of every task the service depends on, so
the resulting image is self-contained and ready to run without hammerkit.

```bash
hammerkit package <registry>
```

The image for a service `api` is named `<registry>/api:<tag>`, where the tag
defaults to `latest` (see [Versioning](#versioning)). The `<registry>` argument is
required - it is the prefix of the produced image name and the target of `--push`.

{% hint style="info" %}
Packaging only runs against the docker runtime. Services without a container
image, and dependency tasks that run locally (without an `image`), are not
supported.
{% endhint %}

## What gets packaged

For every container service hammerkit generates a `Dockerfile` that:

* starts `FROM` the service image,
* copies the generated outputs of the service's dependency tasks (`deps`) into the
  image,
* applies the service `envs`, `ports` (as `EXPOSE`) and `cmd`,
* labels the image with `hammerkit.dev/name` and `hammerkit.dev/id`.

A service with no command and no dependencies still produces a valid image from
its base image and sources.

## Pushing to a registry

Add `--push` to upload the built images to the registry. Credentials can be
passed with `-u/--username` and `-p/--password`.

```bash
hammerkit package registry.example.com --push -u ci -p $REGISTRY_TOKEN
```

### Registry examples

The `<registry>` argument is just the image-name prefix, so any registry works:

```bash
# Docker Hub - produces docker.io/<user>/api
hammerkit package docker.io/<user> --push -u <user> -p $DOCKER_TOKEN

# GitHub Container Registry
hammerkit package ghcr.io/<org> --push -u <user> -p $GITHUB_TOKEN

# GitLab Container Registry (inside CI the variables are provided for you)
hammerkit package registry.gitlab.com/<group>/<project> \
  --push -u $CI_REGISTRY_USER -p $CI_REGISTRY_PASSWORD
```

## Versioning

By default the produced image is tagged `latest`. Use `-t/--tag` to pin an
explicit version - for example a release number or a CI commit sha - so the same
build can be promoted across environments:

```bash
hammerkit package registry.example.com -t 1.2.3 --push
```

produces and pushes `registry.example.com/api:1.2.3`.

## Build platform

By default hammerkit builds for the **host architecture** (`linux/amd64` on x64,
`linux/arm64` on arm64 / Apple Silicon). Override it with `--platform` to build for
a different target, for example when building on arm for an amd64 cluster:

```bash
hammerkit package registry.example.com --platform linux/amd64
```

{% hint style="info" %}
`--platform` is forwarded to the docker build, so the docker daemon must be able to
build that platform (buildkit / emulation enabled for cross-architecture builds).
{% endhint %}

## Example

Given a service that depends on an `install` task:

{% code title=".hammerkit.yaml" %}
```yaml
services:
  api:
    image: node:alpine
    deps: [install]
    cmd: node server.js
    ports: [3000]
    mounts: [server.js]

tasks:
  install:
    image: node:alpine
    src:
      - package.json
      - package-lock.json
    generates:
      - node_modules
    cmds:
      - npm ci
```
{% endcode %}

```bash
hammerkit package localhost:5000 --push
```

produces and pushes `localhost:5000/api`, with the `node_modules` produced by
`install` already baked in.

## Options

```
Options:
  -f, --filter <labels...>   filter task and services with labels
  -e, --exclude <labels...>  exclude task and services with labels
  --push                     push image to registry (default: false)
  --build-override-user      create and run as a dedicated uid/gid 1000 user
  -t, --tag <tag>            image tag (default: "latest")
  --platform <platform>      target build platform (default: host architecture)
  -u, --username             registry username
  -p, --password             registry password
  -h, --help                 display help for command
```
