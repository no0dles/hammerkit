---
description: Lay out a multi-package repo with shared task templates and build order.
---

# Monorepo layout

In a monorepo every package needs the same `install`/`build` steps, and packages
depend on each other in a specific order. Hammerkit handles both with
[includes](../build-file/includes.md) (reuse a task *definition* in each package's
directory) and [references](../build-file/references.md) (wire up cross-package
order). This guide mirrors the runnable
[`examples/monorepo`](https://github.com/no0dles/hammerkit/tree/master/examples/monorepo).

## The layout

```
.hammerkit.yaml          # root: build everything
build.npm.yaml           # shared: how to install
build.tsc.yaml           # shared: how to compile
projects/
  a/.hammerkit.yaml      # package a
  b/.hammerkit.yaml      # package b (depends on a)
```

## Shared templates

Define each repeated step once. `build.npm.yaml` knows how to install; `build.tsc.yaml`
knows how to compile and itself includes the npm install:

{% code title="build.npm.yaml" %}
```yaml
tasks:
  install:
    image: node:24-alpine
    src:
      - package.json
      - package-lock.json
    generates:
      - node_modules
    cmds:
      - npm ci
```
{% endcode %}

{% code title="build.tsc.yaml" %}
```yaml
tasks:
  build:
    image: node:24-alpine
    deps: [npm:install]
    src:
      - tsconfig.json
      - src
    generates:
      - dist
    cmds:
      - node_modules/.bin/tsc -b

includes:
  npm: ./build.npm.yaml
```
{% endcode %}

Because these are **includes**, when a package uses them the `install`/`build`
commands run in *that package's* directory, against *its* `package.json` — exactly
what you want.

## A package

Each package's build file is tiny: it [extends](../task/extending.md) the shared
`tsc:build` template and adds its cross-package dependencies. Package `b` depends
on package `a`, so it references `a` and adds `a:build` to its deps:

{% code title="projects/a/.hammerkit.yaml" %}
```yaml
tasks:
  build:
    extend: tsc:build

includes:
  tsc: ../../build.tsc.yaml
```
{% endcode %}

{% code title="projects/b/.hammerkit.yaml" %}
```yaml
tasks:
  build:
    deps: [a:build]
    extend: tsc:build

references:
  a: ../a

includes:
  tsc: ../../build.tsc.yaml
```
{% endcode %}

## Building everything

The root build file references each package and depends on all of them:

{% code title=".hammerkit.yaml" %}
```yaml
tasks:
  build:
    deps:
      - a:build
      - b:build

references:
  a: projects/a
  b: projects/b
```
{% endcode %}

```bash
hammerkit build
```

Hammerkit builds the dependency graph across files, runs independent packages in
parallel, builds `a` before `b`, and [caches](../task/caching.md) each package
separately — change one package and only it (and anything downstream) rebuilds.

## Scoping with labels

Add [labels](../labels/README.md) to build or test a subset, e.g. label each
package's tasks with `project: a` and run `hammerkit -f project=a`. Combine with
[store / restore](../cli/store-restore.md) to move outputs between CI jobs that
each build part of the repo.
