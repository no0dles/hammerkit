---
description: All about the options that the hammerkit cli offers.
---

# CLI

```
Usage: hammerkit [options] [command]

Options:
  -V, --version                  output the version number
  --verbose                      log debugging information (default: false)
  --file <path>                  set build file (default: .hammerkit.yaml)
  -h, --help                     display help for command

Commands:
  ls [options]                   list all tasks
  clean [options]                clear cache and generated
  store [options] <directory>    save task outputs into <directory>
  restore [options] <directory>  restore task outputs from <directory>
  package [options] <registry>   package services into a docker image
  validate [options]             validate hammerkit configurations
  up [options]                   start services(s)
  down [options]                 stop services(s)
  run [options] [task]           execute task (default command)
  help [command]                 display help for command
```

When no build file is present, only the [`init`](init.md) command is available,
which creates a default `.hammerkit.yaml`. Point hammerkit at a non-default file
with `--file <path>`.

## Common options

These options are shared by the task-running commands ([run](execute.md),
[up](up.md)) and, where they make sense, by `clean`, `store`, `restore` and
`validate`:

| Option | Default | Description |
|--------|---------|-------------|
| `-f, --filter <labels...>` | – | Keep only tasks/services matching `key=value` [labels](../labels/README.md). |
| `-e, --exclude <labels...>` | – | Drop tasks/services matching `key=value` labels. |
| `-c, --concurrency <number>` | `4` | Number of tasks run in parallel. |
| `-w, --watch` | `false` | Re-run tasks when their `src` changes. |
| `--env <name>` | – | Run against a declared [environment](../task/kubernetes.md) (e.g. a cluster). |
| `-l, --log <mode>` | `interactive` (local) / `live` (CI) | `interactive`, `live` or `grouped`. |
| `--cache <method>` | `checksum` | `checksum`, `modify-date` or `none`. See [caching](../task/caching.md). |

Label filters are always `key=value`; a key-only `-f dev` is rejected.

## Parallelism

Independent tasks and dependencies run concurrently up to `--concurrency` workers
(default `4`). A task only starts once all of its `deps` have completed and all of
its `needs` are healthy; tasks on separate branches of the graph run at the same
time. If any task fails, hammerkit stops scheduling new work and the run fails.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Everything requested succeeded (including a fully cached run). |
| `1` | A task, service, or command failed (build error, validation error, store/restore/package/clean/up/down failure). |
| `127` | The requested task was not found. |

These make hammerkit safe to chain in CI with `&&` or as a pipeline step.

## CI detection

Hammerkit auto-detects CI from the `CI`, `CONTINUOUS_INTEGRATION`, `BUILD_NUMBER`
or `RUN_ID` environment variables. The only thing this changes is the **default
log mode** (`live` in CI, `interactive` otherwise). The cache method default is
`checksum` everywhere, so a result cached locally is reused in CI and vice versa.


