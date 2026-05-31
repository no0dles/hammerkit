---
description: >-
  Environment variables can be used from three different sources. Shell
  environment, .env files or predefined values inside the build file.
---

# Environment Variables

## Shell environment

Environment variables which are available from the shell environment get passed into the command before execution.

{% code title=".hammerkit.yaml" %}
```yaml
tasks:
  example:
    envs:
      VERSION: $VERSION
    cmds:
      - echo $VERSION
```
{% endcode %}

{% hint style="info" %}
Each environment variable that is used, should be specified in the `envs` of the task. Hammerkit ensures that the environment variable is defined, otherwise will throw an error to prevent undesired behavior.
{% endhint %}

## .env file

Environment variables can be defined in the .env file. Those are recommended for secret values that should not be committed nor public.

{% code title=".env" %}
```
NPM_TOKEN=abc
```
{% endcode %}

{% code title=".hammerkit.yaml" %}
```yaml
tasks:
  example:
    envs:
      NPM_TOKEN: $NPM_TOKEN
    cmds:
      - npm publish
```
{% endcode %}

## Defined values in the build file

Environment variables can be defined in the build file itself. They can be defined for the entire build file or only for specific tasks.

{% code title=".hammerkit.yaml" %}
```yaml
envs:
  NODE_VERSION: '22'
  
tasks:
  example:
    cmds:
      - echo $NODE_VERSION
      
  override_example:
    envs:
      NODE_VERSION: '20'
    cmds:
      - echo $NODE_VERSION
```
{% endcode %}

{% hint style="warning" %}
The scope of the defined environment variables are fixed to the build file they are defined in. Neither [referenced](references.md) nor [included](includes.md) tasks will have access to those.
{% endhint %}

## Precedence

A variable can be defined in more than one place. Hammerkit resolves it like this:

1. **Task `envs`** win over **build-file `envs`** on the same key. In the example
   above `override_example` prints `20`, while `example` prints `22`.
2. A value of exactly `$NAME` is a *reference* that is filled in from, in order:
   1. the **shell / process environment**, then
   2. a **`.env`** file in the build file's directory.

If a referenced `$NAME` is set nowhere, hammerkit aborts before running with
`missing environment variable NAME` — references are never silently empty.

{% hint style="info" %}
Every variable a task uses must be declared in its `envs` (directly or via
`$NAME`). Hammerkit only passes declared variables to the command, so an
undeclared shell variable is *not* leaked into the task.
{% endhint %}

## Interpolation

There are two distinct places a variable can appear:

**Inside a command** (`cmds`), `$NAME` is expanded by the shell at runtime, using
the variables hammerkit passed in — exactly like a normal shell. This is the
`echo $NODE_VERSION` case above.

**Inside other task fields**, hammerkit substitutes `$NAME` itself when it plans
the task — before anything runs. This works for `image`, `src`, `generates`,
`mounts`, `ports`, `shell` and command working directories, so you can drive them
from a single value:

{% code title=".hammerkit.yaml" %}
```yaml
envs:
  NODE_VERSION: '22'

tasks:
  build:
    image: node:$NODE_VERSION-alpine   # -> node:22-alpine
    src:
      - src
    cmds:
      - tsc -b
```
{% endcode %}

{% hint style="warning" %}
Only the whole-value `$NAME` form is recognised in `envs` (no `${NAME}` braces, no
inline `prefix-$NAME`, no default values). Field substitution matches `$NAME`
anywhere in the string and is case-insensitive. A value defined directly in `envs`
(like `NODE_VERSION: '22'`) is what gets substituted into fields such as `image`.
{% endhint %}
