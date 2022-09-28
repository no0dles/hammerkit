---
description: Runs the task in your build file.
---

# Execute

### Execute a task

```
hammerkit <task_name> [options]
```

### Optional flags

| Flag              |                                                                                                                               | Default     | CI Default |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------- | ---------- |
| -c, --concurrency | Limit of how many task get executed at the same time. Watched task are excluded. To run without limitations, use the value 0. | 4           | 4          |
| --cache           | ignore task caching and run everything even if its up-to-date                                                                 | modify-date | checksum   |
| --no-container    | run every task locally, do not use containers when a task defines an image.                                                   | false       | false      |
| -l, --log         | console log mode                                                                                                              | interactive | live       |
| -w, --watch       | watch mode                                                                                                                    | false       | false      |

