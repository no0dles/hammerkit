---
description: >-
  Explain why a task is a cache hit or a cache miss — without running anything.
---

# Explain

`hammerkit explain [task]` predicts, for every task in scope, whether the next run
would be a **cache hit** or a **cache miss**, and names the input that caused each
miss. Nothing is executed and no container is started. It uses the same state-key
engine as `run`, so the prediction matches what `run` will do.

```bash
hammerkit explain e2e
```

```
• build: cache miss
   cause: source changed: src/app.js
   cause: dependency changed: install
• e2e: cache miss
   cause: dependency changed: build
• install: cache hit
```

## Causes

| Cause | Meaning |
|---|---|
| `never cached` | No result for this task has been recorded yet. |
| `source changed: <file>` | A file in `src` was added, removed or changed. |
| `dependency changed: <task>` | A task in `deps` (transitively) has a different state. |
| `command`, `image`, `env`, `mounts`, … changed | The task definition itself changed (see [cache identity](../task/caching.md#what-gets-cached-and-what-invalidates-it)). |

A task with `cache: none` is reported as `uncacheable`.

## JSON output

`--json` prints a machine-readable list, for CI annotations or agents:

```json
[
  {
    "taskId": "ea717e7627d2e12e24acd731af1d1b364c510f32",
    "taskName": "build",
    "status": "miss",
    "causes": [
      { "kind": "source-changed", "identifier": "src/app.js" },
      { "kind": "dependency-changed", "identifier": "install" }
    ]
  }
]
```

## Related

* `hammerkit run --explain` prints the miss cause inline for every task that
  rebuilds, and adds a cause column to the build summary.
* `hammerkit run --dry-run` prints the execution plan in order — see
  [execute](execute.md#dry-run).

## Options

```
Usage: hammerkit explain [options] [task]

Options:
  -f, --filter <labels...>   filter task and services with labels
  -e, --exclude <labels...>  exclude task and services with labels
  --env <name>               environment
  --cache <method>           caching method to compare (choices: "checksum", "modify-date", "none", default: "checksum")
  --json                     emit the explanation as JSON (default: false)
```
