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

The image for a service `api` is named `<registry>/api`. The `<registry>`
argument is required - it is the prefix of the produced image name and the target
of `--push`.

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
  -u, --username             registry username
  -p, --password             registry password
  -h, --help                 display help for command
```
