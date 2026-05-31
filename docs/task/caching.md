---
description: >-
  A task can be skipped if nothing regarding the input source files has changed.
  This saves a lot of time and resources.
---

# Caching

Every task should define source files it requires. Based on those files, hammerkit can check if since the last run, something has changed that requires to rerun the commands of the task. If all source files are unchanged since the last run, the entire task gets skipped.

{% hint style="warning" %}
If a dependency task has changed or has no source files defined, the task gets executed every run. The task can only get skipped, if all dependencies before can be skipped as well, otherwise the result could be inconsistent.
{% endhint %}

### What gets cached, and what invalidates it

The cached **result** is the task's `generates` output (plus the per-task state
hammerkit keeps under `.hammerkit`). That is what gets reused — and what
[`store` / `restore`](../cli/store-restore.md) and remote
[backends](../build-file/caches.md) move between machines.

A task's cache key is computed from:

* the declared **`src`** files (their content checksum by default, or their
  modification dates with `modify-date`), and
* the cache keys of its **dependencies**, recursively.

So a task is re-run when its `src` changes or when anything it depends on changes.

{% hint style="warning" %}
The key is **not** derived from the `image`, the `cmds`, or `envs`. If you edit a
command or bump an image but leave the `src` untouched, hammerkit still considers
the task up to date and skips it. While iterating on the commands themselves,
re-run with `--cache none` or run [`hammerkit clean`](../cli/clean.md) to force
execution.
{% endhint %}

### Define source files

The following example defines the `package.json` and `package-lock.json` as a source file. Before each run the checksum of those two files are compared with the checksum of the last successful run and if equal the task will get skipped.

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

The next example defines the `src` folder as the task source. The check if the task can be skipped, the entire folder will be recursively traversed.

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
Keep in mind that the recursive traverse can be quite expensive on huge folders. It's not recommended to use for example a `node_modules` folder as a source folder.
{% endhint %}

### Define glob sources

This example defines a glob pattern `src/**/*.ts` as the task source. This is similar to the folder source, but filters for example the extension type.

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

There are multiple patterns supported. Hammerkit uses the node-glob package. For all details checkout the docs [here](https://github.com/isaacs/node-glob) or take a look at a quick summary here:

* `*` Matches 0 or more characters in a single path portion
* `?` Matches 1 character
* `[...]` Matches a range of characters, similar to a RegExp range. If the first character of the range is `!` or `^` then it matches any character not in the range.
* `!(pattern|pattern|pattern)` Matches anything that does not match any of the patterns provided.
* `?(pattern|pattern|pattern)` Matches zero or one occurrence of the patterns provided.
* `+(pattern|pattern|pattern)` Matches one or more occurrences of the patterns provided.
* `*(a|b|c)` Matches zero or more occurrences of the patterns provided
* `@(pattern|pat*|pat?erN)` Matches exactly one of the patterns provided
* `**` If a "globstar" is alone in a path portion, then it matches zero or more directories and subdirectories searching for matches. It does not crawl symlinked directories.

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
built-in backends are `local` and `s3`; the `s3` backend also covers any
S3-compatible store such as MinIO, Cloudflare R2 and Google Cloud Storage. See
[caches](../build-file/caches.md) for the full backend reference, the R2/GCS
examples and the pull/push behavior.
