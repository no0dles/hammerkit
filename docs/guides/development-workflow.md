---
description: A tight local loop with watch, services and dependency-aware restarts.
---

# Development workflow

Hammerkit isn't only for CI — the same build file drives a fast local loop. This
guide combines [watch](../task/watching.md), [services](../service/README.md) and
[needs](../task/needs.md) into a develop-on-save setup.

## Watch a task

`--watch` re-runs a task when its `src` changes, and — because hammerkit knows the
graph — re-runs anything downstream too, reusing cached results for everything
unchanged. A short debounce coalesces a burst of saves into one restart.

{% code title=".hammerkit.yaml" %}
```yaml
tasks:
  api:
    image: node:22-alpine
    src:
      - src
    cmds:
      - node src/index.js
```
{% endcode %}

```bash
hammerkit api --watch
```

## Let the tool watch itself

Some tools already do incremental rebuilds faster than a full task restart
(`tsc -w`, `ng serve`, `vite`, `nodemon`). Mark those `continuous: true` so
hammerkit starts them once and does **not** restart them on file changes in watch
mode:

{% code title=".hammerkit.yaml" %}
```yaml
tasks:
  serve:
    image: node:22-alpine
    continuous: true
    src:
      - src
    cmds:
      - npm run dev
```
{% endcode %}

## Keep services up while you work

A task that `needs` a service starts and stops it around each run. During
development you usually want the database to stay up across many runs — start the
services once in the background and leave them:

```bash
hammerkit up --daemon     # start services, return immediately
hammerkit api --watch     # iterate; the db keeps running
hammerkit down            # stop services when you're done
```

`up --watch` also restarts services whose mounted config changes. Attach a
[volume](../service/container.md#volumes) so the database keeps its data between
restarts.

## Putting it together

A typical loop for an API with a database and a frontend:

{% code title=".hammerkit.yaml" %}
```yaml
services:
  postgres:
    image: postgres:16-alpine
    healthcheck:
      cmd: "pg_isready -U dev"
    volumes:
      - "dev-db:/var/lib/postgresql/data"
    ports:
      - 5432

tasks:
  api:
    image: node:22-alpine
    needs: [postgres]
    labels:
      stage: dev
    src:
      - src
    cmds:
      - npm run dev

  web:
    image: node:22-alpine
    continuous: true
    labels:
      stage: dev
    src:
      - web
    cmds:
      - npm run dev --prefix web
```
{% endcode %}

```bash
hammerkit up --daemon       # postgres in the background
hammerkit -f stage=dev --watch
```

Group the dev tasks with a [label](../labels/README.md) (`stage: dev`) so a single
filtered command starts exactly the watch loop you want. See
[labels](../labels/README.md) for the grouping pattern.

{% hint style="info" %}
Local-vs-container still applies in dev: a task with an `image` runs in a container
(consistent tooling, recommended); drop the `image` to run on the host when you
need a tool that's only installed locally. See
[local vs. container tasks](local-vs-container.md).
{% endhint %}
