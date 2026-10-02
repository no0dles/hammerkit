---
description: >-
  A task can depend on other tasks, which run first (unless they are cached).
---

# Dependencies

Every task can have a list of dependencies. They run before the task, and if any of them fails, all pending tasks are aborted. Dependencies can be chained as deep as needed, as long as there is no cycle.

{% code title=".hammerkit.yaml" %}
```yaml
tasks:
  install:
    cmds:
      - npm install
      
  build:
    deps: [install]
    cmds:
      - tsc -b
  
  publish:
    deps: [build]
    cmds:
      - npm publish
```
{% endcode %}

## Dependencies run in parallel

Dependencies that don't depend on each other run **concurrently**, up to the
`--concurrency` worker count (default `4`). In the example above `install` must
finish before `build`, but if two branches of the graph are independent they
execute at the same time. A dependency that fails stops the whole run; see
[parallelism and exit codes](../cli/README.md#parallelism) in the CLI reference.

## Dependencies of cached tasks

A dependency only runs when a task that needs it has to run. If every task
depending on it is a cache hit, it is **skipped**: when `e2e` is cached,
`hammerkit run e2e` doesn't rebuild the app `e2e` was tested against. Skipped tasks
show up as `skipped` in the [build summary](../cli/execute.md#build-summary).

Tasks you ask for — by name, or selected with a [label filter](../labels/README.md)
— always run (or restore from the cache); only tasks pulled in purely as
dependencies are skipped. Dependencies of services, and everything in watch mode,
always run.

{% hint style="info" %}
A skipped dependency leaves no outputs in the workspace. If you need them — for
example an exported `dist` — request that task too, or pass `--no-skip-deps` to run
the whole dependency graph as in earlier versions.
{% endhint %}

Referenced and included tasks are addressed with the `prefix:task` syntax in
`deps`, for example `deps: [npm:install]`. See
[references](../build-file/references.md) and [includes](../build-file/includes.md).

{% hint style="info" %}
Make sure to set up correct [caching](caching.md) to speed up your execution and prevent unnecessary work.
{% endhint %}
