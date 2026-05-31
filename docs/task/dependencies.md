---
description: >-
  A task can require dependent tasks that will get executed first (if not
  cached).
---

# Dependencies

Every task can have list of dependencies. Those will be executed before and if any of them fails abort the all pending tasks. Dependencies can be chained as deep as needed, as long as there is no loop.&#x20;

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

Referenced and included tasks are addressed with the `prefix:task` syntax in
`deps`, for example `deps: [npm:install]`. See
[references](../build-file/references.md) and [includes](../build-file/includes.md).

{% hint style="info" %}
Make sure to set up correct [caching](caching.md) to speed up your execution and prevent unnecessary work.
{% endhint %}
