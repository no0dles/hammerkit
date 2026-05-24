---
description: All about the options that the hammerkit cli offers.
---

# CLI

```
Usage: hammerkit [options] [command]

Options:
  -V, --version                  output the version number
  --verbose                      log debugging information (default: false)
  --file                         set build file (default: .hammerkit.yaml)
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
which creates a default `.hammerkit.yaml`.


