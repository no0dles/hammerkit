---
description: Runs the task in your build file.
---

# Execute

## Execute a task
Tasks can be executed by name.

```bash
task example
```

## Execute tasks with labels
Tasks can be executed by matching labels or filtered by label values. 

### By matching labels
The `-f type=build` will only execute tasks that have the given label value. 
Dependant tasks do not need to fullfill the label requirement.
```
task -f type=build
```

### By matching labels
The `-f build=ios` will only execute tasks have no matching label value.
If the task has no matching label, but any of the dependency tasks has a match, the task will be excluded as well. 
```
task -e build=ios
```

## Options
```
Options:
  -f, --filter <labels...>    filter task and services with labels
  -e, --exclude <labels...>   exclude task and services with labels
  -c, --concurrency <number>  parallel worker count (default: 4)
  -w, --watch                 watch tasks (default: false)
  -l, --log <mode>            log mode (choices: "interactive", "live", "grouped", default: "interactive")
  --cache <method>            caching method to compare (choices: "checksum", "modify-date", "none", default: "modify-date")
  --no-container              run every task locally without containers
  -h, --help                  display help for command

```
