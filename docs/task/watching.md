---
description: >-
  For tasks whose source files change frequently and should re-run on every
  change.
---

# Watching

Tasks with source folders and files can be watched and restarted when they change.
This is useful, for example, to run API servers that restart when the server code changes.

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


## Continuous tasks

Some tasks are continuous and watch their files themselves.
For example, the Angular CLI watches for file changes and rebuilds incrementally, which is faster than hammerkit restarting the task.
Mark such tasks with `continuous: true`; in watch mode, hammerkit then does not watch their source files.

```yaml
tasks:
  serve:
    image: node:24
    continuous: true
    src: 
      - src
      - angular.json
    cmds:
      - ng serve
```
