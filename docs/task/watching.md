---
description: >-
  For tasks which source files change frequently and require to redo the work on
  a watch.
---

# Watching

Tasks with source folders and files can be watched and, on change, get restarted. 
This can be used for example to run api servers that restart when the server code changes.

```yaml
tasks:
  api:
    src:
      - src
    cmds:
      - node -r ts-node/register src/index.ts
```

```bash
hammerkit api --watch
```

In watch mode hammerkit watches the `src` of every task in the run. When a file
changes it re-runs the affected task — and, because it knows the dependency graph,
any tasks downstream of it — reusing cached results for everything unchanged. A
short debounce coalesces bursts of saves into a single restart. Combine `--watch`
with services (via `needs`, or [`hammerkit up --watch`](../cli/up.md)) to keep a
database running while your api restarts on every edit; the
[development workflow guide](../guides/development-workflow.md) puts these together.


# Continuous tasks

Task may be continuous and watch for their file changes themselve.
For example the angular/cli will watch for file changes and restart the build incremental and therefore performs faster than hammerkit can do with restarting the task.
It's recommended to mark such tasks with `continuous: true`.
Hammerkit will then not watch for files change in the source directory of such tasks if started in watch mode.

```yaml
tasks:
  serve:
    image: node:22
    continuous: true
    src: 
      - src
      - angular.json
    cmds:
      - ng serve
```
