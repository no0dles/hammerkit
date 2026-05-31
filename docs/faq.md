---
description: Common questions and the gotchas behind them.
---

# FAQ & Troubleshooting

## Where did my `dist` go? My container task ran but the files aren't in my project.

By default a container task's `generates` stay **inside the container volume** —
fast, and reused on the next run, but not copied back to your working directory.
Mark a generate with `export: true` to copy it back out:

{% code title=".hammerkit.yaml" %}
```yaml
tasks:
  build:
    image: node:24-alpine
    generates:
      - path: dist
        export: true
    cmds:
      - npm run build
```
{% endcode %}

See [exporting generated files](task/README.md#exporting-generated-files).

## Why does my task run every time, even when nothing changed?

A task can only be skipped if it declares `src` **and** all of its dependencies can
also be skipped. A task with no `src`, or one that depends on a task with no `src`,
runs every time — hammerkit can't prove it's up to date. Give each task accurate
`src`/`generates`. See [caching](task/caching.md).

## I edited a command (or bumped the image) but the task is still skipped.

The cache key is built from the `src` files and dependencies only — **not** from
`cmds`, `image` or `envs`. While iterating on the commands themselves, force a run
with `--cache none` or [`hammerkit clean`](cli/clean.md). See
[what invalidates a key](task/caching.md#what-gets-cached-and-what-invalidates-it).

## No cache hits in CI, even though the code didn't change.

Almost always the `modify-date` method on a fresh checkout: `git clone` resets file
modification times on every run, so a `modify-date` task always looks changed. Use
the default `checksum` method in CI (it compares content, which is stable across
checkouts). See [checksum vs. modify-date](task/caching.md#checksum-vs-modify-date)
and the [CI caching guide](guides/ci-caching.md).

## `Cannot connect to the Docker daemon` / `docker: command not found`.

A task with an `image` needs a running container engine. Verify with `docker info`.
If you don't want Docker for a step, remove its `image` so it runs on the host. See
[installation](installation.md).

## A task fails with `missing environment variable NAME`.

A `$NAME` reference in `envs` couldn't be resolved from the shell or a `.env` file.
Either export the variable, add it to `.env`, or give the `env` a literal value.
Hammerkit fails fast here on purpose so a build never runs with a silently-empty
variable. See [environment variables](build-file/environment-variables.md#precedence).

## My task hangs "waiting" for a service that's running.

The service's [healthcheck](service/container.md#timing-and-failure) never exits
`0`, so hammerkit never considers it ready. There's no readiness deadline, so it
waits indefinitely. Make the `cmd` a real readiness probe (like `pg_isready`) and
confirm it succeeds inside the container.

## My container task can't reach the service.

A container task reaches a service by its **name** as the hostname on the service's
**container port** (e.g. `postgres:5432`) — not via a published `ports` entry, and
not via the `HAMMERKIT_*` variables (those are injected only for **local** tasks).
See [services & networking](guides/services-networking.md).

## Generated files are owned by `root` (Linux).

On Linux a container task runs as your `uid:gid` and hammerkit `chown`s the working
directory and mounts to you, so new files come back owned by you. The `chown` is
not recursive, so root-owned files baked into the image are left as-is. On
macOS/Windows the Docker Desktop VM handles this. See
[file permission](task/container.md#file-permission).

## `No tasks found` (exit code 127).

The task name you asked for doesn't exist in the resolved build file. Run
[`hammerkit ls`](cli/ls.md) to see the available task names (including
`prefix:name` ones from references/includes). For the full exit-code contract see
the [CLI reference](cli/README.md#exit-codes).

## Which file does hammerkit use as the build file?

It looks for `.hammerkit.yaml`, then `.hammerkit.yml`, then `build.yaml`, and uses
the first it finds (warning if several exist). Override with `--file <path>`. See
the [build file](build-file/README.md).
