---
description: >-
  A task can be skipped if none of its inputs have changed. This saves a lot of
  time and resources.
---

# Caching

Every task should declare the source files it requires. Based on those files, hammerkit checks whether anything changed since the last run that requires the task's commands to run again. If all source files are unchanged, the task is skipped.

{% hint style="warning" %}
A task can only be skipped if all of its dependencies can be skipped as well; otherwise the result could be inconsistent. When a dependency changes, every task depending on it runs again.
{% endhint %}

### What gets cached, and what invalidates it

The cached **result** is the task's `generates` output (plus the per-task state
hammerkit keeps under `.hammerkit`). That is what gets reused — and what
[`store` / `restore`](../cli/store-restore.md) and remote
[backends](../build-file/caches.md) move between machines.

A task's cache key has two parts:

* the task's **definition**: `cmds`, `image` (or the host OS for a local task),
  the CPU architecture, `envs`, `mounts`, `shell`, `src` and `generates` paths,
  the working directory, and the definitions of its **dependencies**, and
* its **state**: the declared **`src`** files (their content checksum by default,
  or their modification dates with `modify-date`) combined with the state of its
  **dependencies**, recursively.

So a task is re-run when its definition changes, when its `src` changes, or when
anything it depends on changes — its dependencies' sources *or* their definitions.
Use [`hammerkit explain`](../cli/explain.md) to see which of these caused a
rebuild.

Changing a task's `description`, `labels` or `timeout` does not invalidate it.

A task's `src` may point at what a dependency `generates` (an `e2e` task reading
`dist`, say). Those files are not hashed again: they are represented by the
dependency's definition and state. So the task has the same key on a clean
checkout, where `dist` isn't built yet, as in a workspace where it is — which is
what lets a clean CI checkout reuse what an agent pushed.

A cache hit restores the task's outputs where they are expected: a container
task's exported directories and file outputs on the host, the rest in its
volumes. Deleting an output (`rm -rf dist`) makes the task restore it from a
cache backend, or run again.

{% hint style="info" %}
The architecture is part of the key because outputs often contain native
binaries (esbuild, cypress, native node modules), and Docker pulls images for
the host's architecture. An arm64 laptop and an x64 CI runner therefore don't
share cache entries.
{% endhint %}

{% hint style="warning" %}
An `image` is identified by its name, not its content. A tag such as
`node:24-alpine` moves when it is republished, and hammerkit keeps using results
built with the old image. Pin images by digest
(`node:24-alpine@sha256:…`) where that matters.
{% endhint %}

All paths in the key are relative to the project root (the git root, or the
directory of the main build file), so the same commit has the same keys in every
checkout — on a laptop, a CI runner or an agent sandbox. That is what lets a
[remote cache](../build-file/caches.md) be shared between machines.

{% hint style="warning" %}
A task **without `src`** of its own can't be proven up to date, so it runs every
time — and so does every task that depends on it. Its dependencies' `src` doesn't
count: it says nothing about the files the task's own commands read. Declare
`src` on everything you want cached.
The same applies when every `src` entry of a task matches no file (a typo, a
moved directory). Each `src` entry that matches no file is reported as a warning.
{% endhint %}

### Define source files

The following example declares `package.json` and `package-lock.json` as source files. Before each run, the checksums of those two files are compared with the checksums from the last successful run; if they are equal, the task is skipped.

{% code title=".hammerkit.yaml" %}
```yaml
tasks:
  install:
    src:
      - package.json
      - package-lock.json
    cmds:
      - npm install
```
{% endcode %}

### Define source folders

The next example declares the `src` folder as the task source. To check whether the task can be skipped, the entire folder is traversed recursively.

{% code title=".hammerkit.yaml" %}
```yaml
tasks:
  build:
    src:
      - src
    cmds:
      - tsc -b
```
{% endcode %}

{% hint style="warning" %}
Keep in mind that the recursive traversal can be expensive on huge folders. Avoid using, for example, a `node_modules` folder as a source.
{% endhint %}

### Define glob sources

This example defines a glob pattern `src/**/*.ts` as the task source. This is similar to a folder source, but filters, for example, by file extension: every `.ts` file under `src`, in any subdirectory.

{% code title=".hammerkit.yaml" %}
```yaml
tasks:
  build:
    src:
      - src/**/*.ts
    cmds:
      - tsc -b
```
{% endcode %}

Globs are matched against paths relative to the task's directory, and may use
environment variables (`$DIR/**/*.ts`). Several patterns are supported. Hammerkit matches globs with [minimatch](https://github.com/isaacs/minimatch) (the matcher behind node-glob); see its docs for all details. A quick summary:

* `*` Matches 0 or more characters in a single path portion.
* `?` Matches 1 character.
* `[...]` Matches a range of characters, similar to a RegExp range. If the first character of the range is `!` or `^` then it matches any character not in the range.
* `!(pattern|pattern|pattern)` Matches anything that does not match any of the patterns provided.
* `?(pattern|pattern|pattern)` Matches zero or one occurrence of the patterns provided.
* `+(pattern|pattern|pattern)` Matches one or more occurrences of the patterns provided.
* `*(a|b|c)` Matches zero or more occurrences of the patterns provided.
* `@(pattern|pat*|pat?erN)` Matches exactly one of the patterns provided.
* `**` If a "globstar" is alone in a path portion, then it matches zero or more directories and subdirectories searching for matches.
* `{a,b}` Matches either of the comma-separated alternatives.

{% hint style="info" %}
A glob starting with `**` walks the whole task directory, including
`node_modules`. Start it at the directory that holds the sources (`src/**/*.ts`)
to keep that cheap.
{% endhint %}

### checksum vs. modify-date

`checksum` is the default method, both locally and in CI. It compares the
**content** of the `src` files, so a result built on one machine is correctly
reused on another — including a fresh CI runner.

{% hint style="warning" %}
Prefer `checksum` for anything shared with CI. `modify-date` compares file
**modification times**, which a `git clone` resets to "now" on every fresh
checkout — so on a clean CI runner a `modify-date` task looks changed every time
and never hits the cache. `modify-date` is only a local optimization for very large
source folders where hashing is expensive; it is not portable across machines.
{% endhint %}

### Selecting a cache method

By default a task is skipped based on the content checksum of its source files.
The `cache` field can change the method per task. The shorthand form takes one of
`checksum`, `modify-date` or `none`.

{% code title=".hammerkit.yaml" %}
```yaml
tasks:
  build:
    cache: modify-date
    src:
      - src
    cmds:
      - tsc -b
```
{% endcode %}

### Changing the default for all tasks

A task without a `cache` field uses the built-in `default` cache, and its method
is the global default rather than something declared on the task. There are two
ways to change that default for every such task.

**Per run - the `--cache` flag.** Pass `--cache <method>` to set the method for
all tasks that did not declare their own `cache`. The choices are `checksum`,
`modify-date` and `none`. The default is `checksum` both locally and in CI, so a
result cached on one machine is reused on the other. See
[execute](../cli/execute.md) for the full option reference.

{% code title="terminal" %}
```bash
hammerkit build --cache checksum
```
{% endcode %}

**Persistently - redeclare `caches.default`.** To change the default cache
*backend* for every task (for example to share results through a remote bucket),
redeclare the built-in `default` cache in the build file. See
[caches](../build-file/caches.md#built-in-caches).

{% hint style="info" %}
An explicit `cache` on a task always wins. Both the shorthand
(`cache: modify-date`) and the object form are left untouched by `--cache`, so
only tasks that did not opt in follow the global default.
{% endhint %}

### Remote caches & backends

A task can reference a named [cache](../build-file/caches.md) with a remote
backend, so its result can be shared between machines and CI runs. Reference a
cache by name and optionally override its method.

{% code title=".hammerkit.yaml" %}
```yaml
caches:
  remote:
    method: checksum
    backend:
      type: s3
      bucket: my-build-cache
      region: eu-central-1

tasks:
  build:
    cache:
      name: remote        # use the "remote" cache declared above
      method: checksum    # optional, overrides the cache method
    src:
      - src
    generates:
      - dist
    cmds:
      - tsc -b
```
{% endcode %}

When the cache has a remote backend, hammerkit pulls the result before the task
runs if it is missing locally, and pushes the result after a successful run. The
built-in backends are `local`, `s3` and `registry`; the `s3` backend also covers
any S3-compatible store such as MinIO, Cloudflare R2 and Google Cloud Storage, and
the `registry` backend any OCI container registry (GHCR, Docker Hub, ECR, …). See
[caches](../build-file/caches.md) for the full backend reference, the R2/GCS
examples and the pull/push behavior.

To keep the network out of the build, leave tasks on the machine-local `default`
cache and move entries explicitly with [`cache pull` / `cache push`](../cli/cache.md);
see [agents, workspaces and CI](../guides/agents-and-ci.md).
