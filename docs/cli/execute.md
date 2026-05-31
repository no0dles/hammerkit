---
description: Runs the task in your build file.
---

# Execute

Running `hammerkit` without a command (or with the explicit `run` command)
executes a task. It is the default command, so `hammerkit build` and
`hammerkit run build` are equivalent.

## Execute a task
Tasks can be executed by name.

```bash
hammerkit example
```

## Execute tasks with labels
Tasks can be executed by matching labels or filtered by label values.

### By matching labels
The `-f type=build` will only execute tasks that have the given label value.
Dependent tasks do not need to fulfill the label requirement.
```bash
hammerkit -f type=build
```

### By excluding labels
The `-e build=ios` will exclude tasks that have the given label value.
If the task has no matching label, but any of the dependency tasks has a match, the task will be excluded as well.
```bash
hammerkit -e build=ios
```

## Options
```
Options:
  -f, --filter <labels...>    filter task and services with labels
  -e, --exclude <labels...>   exclude task and services with labels
  -c, --concurrency <number>  parallel worker count (default: 4)
  -w, --watch                 watch tasks (default: false)
  --env <name>                environment
  -l, --log <mode>            log mode (choices: "interactive", "live", "grouped")
  --cache <method>            caching method to compare (choices: "checksum", "modify-date", "none")
  -h, --help                  display help for command
```

{% hint style="info" %}
`--cache` defaults to `checksum` everywhere — the same comparison runs locally and
in CI, so a result cached on one is reused on the other. `--log` defaults to
`interactive` outside CI and `live` in CI (hammerkit auto-detects CI from the `CI`,
`CONTINUOUS_INTEGRATION`, `BUILD_NUMBER` or `RUN_ID` environment variables).
{% endhint %}
