---
description: >-
  For tasks which source files change frequently and require to redo the work on
  a watch.
---

# Watching

Task with source folders and files can be watched and on changed get restarted. 
This can be used for example to run api servers and restarted if the server code changes.

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


# Continuous tasks

Task may be continuous and watch for their file changes themselve.
For example the angular/cli will watch for file changes and restart the build incremental and therefore performs faster than hammerkit can do with restarting the task.
It's recommended to mark such tasks with `continuous: true`.
Hammerkit will then not watch for files change in the source directory of such tasks if started in watch mode.

```yaml
tasks:
  serve:
    image: node:16
    continuous: true
    src: 
      - src
      - angular.json
    cmds:
      - ng serve
```
