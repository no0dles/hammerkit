---
description: >-
  Environment variables come from three sources: the shell environment, .env
  files and values defined in the build file.
---

# Environment Variables

## Shell environment

Variables from the shell environment are passed to a command when the task declares them:

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
Every environment variable a task uses should be declared in its `envs`. Hammerkit checks that each one is defined and otherwise fails with an error, to prevent undesired behavior.
{% endhint %}

## .env file

Environment variables can be defined in a `.env` file. This is recommended for secret values that should neither be committed nor made public.

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
Variables defined in a build file are scoped to that file. Neither [referenced](references.md) nor [included](includes.md) tasks have access to them.
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
`mounts`, `ports`, `shell`, command working directories and a service's `image`,
so you can drive them from a single value:

{% code title=".hammerkit.yaml" %}
```yaml
envs:
  NODE_VERSION: '24'

tasks:
  build:
    image: node:$NODE_VERSION-alpine   # -> node:24-alpine
    src:
      - src
    cmds:
      - tsc -b
```
{% endcode %}

{% hint style="warning" %}
Only the whole-value `$NAME` form is recognized in `envs` (no `${NAME}` braces, no
inline `prefix-$NAME`, no default values). Field substitution matches `$NAME`
anywhere in the string and is case-insensitive. A value defined directly in `envs`
(like `NODE_VERSION: '24'`) is what gets substituted into fields such as `image`.
{% endhint %}
