---
description: Build, test and cache a real Node + TypeScript project end to end.
---

# Tutorial

This walkthrough takes a small TypeScript project from nothing to a cached,
container-based `install → build → test` pipeline that runs the same way on your
laptop and in CI. It assumes you've done [getting started](getting-started.md) and
have a container engine running (`docker info`).

The finished build files for every pattern shown here live in the runnable
[`examples/`](https://github.com/no0dles/hammerkit/tree/master/examples) folder —
`hello-world-node`, `store-restore`, `services` and `monorepo` are the closest to
this tutorial.

## 1. The project

Start with an ordinary Node project — a `package.json` with scripts, a
`tsconfig.json`, and `src/`:

```json
{
  "name": "demo",
  "scripts": {
    "build": "tsc -b",
    "test": "node --test"
  },
  "devDependencies": { "typescript": "^5.4.0" }
}
```

We won't install Node, TypeScript, or anything else on the host — every step runs
in a `node` container.

## 2. Install dependencies

Create `.hammerkit.yaml` with an `install` task. It declares its inputs (`src`) and
outputs (`generates`) so hammerkit can cache it:

{% code title=".hammerkit.yaml" %}
```yaml
envs:
  NODE_VERSION: '22'

tasks:
  install:
    image: node:$NODE_VERSION-alpine
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
hammerkit install
```

The first run pulls `node:22-alpine` and runs `npm ci` inside it. Run it again and
hammerkit reports it cached — `package.json`/`package-lock.json` are unchanged, so
there's nothing to do.

## 3. Build

Add a `build` task that depends on `install`. The `deps` makes hammerkit run (or
reuse) `install` first:

{% code title=".hammerkit.yaml" %}
```yaml
envs:
  NODE_VERSION: '22'

tasks:
  install:
    image: node:$NODE_VERSION-alpine
    src:
      - package.json
      - package-lock.json
    generates:
      - node_modules
    cmds:
      - npm ci

  build:
    image: node:$NODE_VERSION-alpine
    deps: [install]
    src:
      - src
      - tsconfig.json
    generates:
      - dist
    cmds:
      - npm run build
```
{% endcode %}

```bash
hammerkit build
```

Edit a file under `src/` and re-run: `install` stays cached (its inputs didn't
change) and only `build` re-runs. That's the payoff of declaring `src`/`generates`
per task.

## 4. Test

Add a `test` task. It also depends on `install`, so on a clean run `install` runs
once and `build` and `test` run afterwards — independent of each other, so they run
in parallel:

{% code title=".hammerkit.yaml" %}
```yaml
tasks:
  test:
    image: node:22-alpine
    deps: [install]
    src:
      - src
      - test
    cmds:
      - npm test
```
{% endcode %}

```bash
hammerkit test
```

Run `hammerkit ls` at any point to see the whole graph hammerkit has built.

## 5. Add a service for integration tests

If your tests need a database, declare it as a [service](service/README.md) and
let the test task `need` it. Hammerkit starts the database, waits for the
healthcheck, runs the tests, then stops it:

{% code title=".hammerkit.yaml" %}
```yaml
services:
  postgres:
    image: postgres:16-alpine
    envs:
      POSTGRES_USER: demo
      POSTGRES_DB: demo
      POSTGRES_HOST_AUTH_METHOD: trust
    healthcheck:
      cmd: "pg_isready -U demo"
    ports:
      - 5432

tasks:
  integration:
    image: node:22-alpine
    deps: [install]
    needs: [postgres]
    envs:
      DATABASE_URL: postgres://demo@postgres:5432/demo
    src:
      - src
      - test
    cmds:
      - npm run test:integration
```
{% endcode %}

A container task reaches the service by its **name** (`postgres`) on its container
port (`5432`) — see [needs](task/needs.md) and
[services & networking](guides/services-networking.md).

## 6. Cache across CI runs

Everything above already caches **locally**. To share that work with CI so a fresh
runner reuses results instead of rebuilding, you have two options:

* point the built-in `default` cache at a remote [backend](build-file/caches.md)
  (an S3 bucket) — pull/push then happens automatically, or
* wrap the run in [`store` / `restore`](cli/store-restore.md) around your CI
  provider's own cache step.

Because the cache method is `checksum` by default, a result built on your laptop is
correctly reused on the runner and vice versa. The
[CI caching guide](guides/ci-caching.md) walks through both options.

## Where to go next

* [Guides](guides/ci-caching.md) — CI caching, services & networking, monorepos, dev workflow.
* [Recipes](recipes.md) — ready-made task files for tsc, npm, eslint, jest, docker, helm and more.
* [Build file reference](build-file/reference.md) — every key, in one place.
