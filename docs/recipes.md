---
description: Ready-made task templates for common tools.
---

# Recipes

The repository ships a set of reusable build-file templates under
[`best-practices/`](https://github.com/no0dles/hammerkit/tree/master/best-practices).
Each one defines the tasks for a single tool so you can [include](build-file/includes.md)
it and [extend](task/extending.md) its tasks instead of writing them from scratch.

## Available templates

| File | Tasks | Tool |
|------|-------|------|
| `build.npm.yaml` | `install`, `install:prod`, `install:dev`, `ci`, `publish` | npm install / publish |
| `build.tsc.yaml` | `build` | TypeScript compiler |
| `build.eslint.yaml` | `check`, `fix` | ESLint |
| `build.prettier.yaml` | `format` | Prettier |
| `build.jest.yaml` | `test` | Jest (with coverage) |
| `build.docker.yaml` | `login`, `build`, `publish` | Docker buildx (multi-arch) |
| `build.helm.yaml`, `build.helm2.yaml` | `help`, `ls` | Helm 3 / Helm 2 |
| `build.gcloud.yaml` | `help`, `auth:login` | Google Cloud SDK |
| `build.dotnet.yaml` | `db:update` | .NET EF migrations |

## Using a recipe

Include the template under a prefix, then either call its tasks directly
(`hammerkit tsc:build`) or [extend](task/extending.md) one as a base in your own
task:

{% code title=".hammerkit.yaml" %}
```yaml
tasks:
  build:
    extend: tsc:build

includes:
  tsc: ./build.tsc.yaml
```
{% endcode %}

The npm-based recipes (`tsc`, `eslint`, `prettier`, `jest`) already
[include](build-file/includes.md) `build.npm.yaml` and depend on its `ci` task, so
`install` runs (and caches) before each of them.

{% hint style="info" %}
The recipes pin a specific image (for example `node:24-alpine`) — copy them into
your project and set the image to the version you actually build with.
The recipes are a starting point, not a dependency.
{% endhint %}

## Secret-bearing recipes

`build.docker.yaml`, `build.npm.yaml` (`publish`) and `build.gcloud.yaml` read
secrets such as `DOCKER_TOKEN` or `NPM_TOKEN` from the environment via
`$NAME` references. Provide them through the shell or a `.env` file — see
[environment variables](build-file/environment-variables.md). They are never stored
in the build file.
