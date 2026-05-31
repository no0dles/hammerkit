---
description: Verify the build file is well-formed and spot mistakes early on.
---

# Validate

`validate` checks the build file (and everything it references/includes) without
running anything, so you can catch mistakes early — ideal as a CI lint step.

```bash
hammerkit validate
```

It reports two levels:

* **error** — something that would break a run, such as a dependency cycle. Any
  error makes `validate` exit with code `1`.
* **warn** — something suspicious that still runs, such as a task with no
  description, a container service without a healthcheck, or a `src`/`mount` path
  that doesn't exist. Warnings do **not** change the exit code.

## A clean run

With no problems, nothing is reported and the command exits `0`:

```
hammerkit validate
```

## A run with findings

Each finding is grouped by the file it came from and shows its level, the item it
applies to, and a message:

```
.hammerkit.yaml
 warn at postgres missing healthcheck
 warn at build missing description
 error at build task cycle detected build -> test -> build
```

Here the two warnings are advisory, but the cycle is an error, so the command exits
`1` and a CI job using it fails.

{% hint style="success" %}
This command is recommended to be used in CI together with other linting jobs.
{% endhint %}

{% hint style="info" %}
A malformed build file (an unknown key, a missing required `image`, the wrong
type) is rejected by the schema as soon as hammerkit reads it — on *any* command,
not just `validate`. `validate` adds the semantic checks above on top of that.
{% endhint %}

## Options

```
Options:
  -f, --filter <labels...>   filter task and services with labels
  -e, --exclude <labels...>  exclude task and services with labels
  -h, --help                 display help for command
```
