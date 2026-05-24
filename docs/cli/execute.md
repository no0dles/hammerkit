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
Dependant tasks do not need to fullfill the label requirement.
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
The defaults for `--log` and `--cache` depend on the environment: outside CI they
are `interactive` and `modify-date`, in CI they are `live` and `checksum`.
{% endhint %}
