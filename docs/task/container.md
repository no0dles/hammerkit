---
description: >-
  A task can run inside a container. This improves cross-platform support for
  your build files and reduces the number of locally installed tools required
  to run your tasks.
---

# Container

Every task can run inside a container. All you need is to set an `image` property on your task.

{% code title=".hammerkit.yaml" %}
```yaml
tasks:
  install:
    image: node:24-alpine
    cmds:
      - npm install
```
{% endcode %}

This example runs `npm install` inside a container with the image `node:24-alpine`. However, the container has no access to your local files, so nothing gets installed. To give it access to your project files, use sources, generates and mounts.

### Adding source files/folders

All source files and folders are mounted when the container starts and can be accessed inside it.

{% code title=".hammerkit.yaml" %}
```yaml
tasks:
  install:
    image: node:24-alpine
    src:
      - package.json
      - package-lock.json
    cmds:
      - npm install
```
{% endcode %}

### Adding output files/folders

The installed node\_modules are written to the container's file system. If those files and folders are needed after the task has finished, declare them under `generates`.

```yaml
tasks:
  install:
    image: node:24-alpine
    src:
      - package.json
      - package-lock.json
    generates:
      - node_modules
    cmds:
      - npm install
```

### Adding mounts

For other files and folders that are neither sources nor generates, use mounts. They can be relative, absolute or relative to your home directory.

{% code title=".hammerkit.yaml" %}
```yaml
tasks:
  install:
    image: node:24-alpine
    src:
      - package.json
      - package-lock.json
    generates:
      - node_modules
    mounts:
      - relative/path
      - /some/absolute/path
      - .npm:/root/.npm
    cmds:
      - npm install
```
{% endcode %}

A mount is written `host[:container]`:

* `path` — a single path mounts the host path to the **same** path inside the
  container.
* `host:container` — mounts the host path on the left to the container path on the
  right. More than one `:` is an error.

Host paths can be relative (resolved against the build file's directory), absolute,
or `~`-relative to your home directory. Relative container paths resolve against the
task's working directory.

### Working directory

A container task runs with its working directory set to the build file's directory
(mirrored inside the container), and your sources are mounted there. So relative
paths in `cmds` (`node_modules/.bin/tsc`, `./script.sh`) behave just like they would
when running on the host.

{% hint style="info" %}
The sources and generates of all dependencies are mounted into the container automatically. This avoids long lists of mounts and keeps tasks consistent.
{% endhint %}

### Execution shell

By default, each command runs in a `sh` shell. Override it with a `shell` property on the task.

{% code title=".hammerkit.yaml" %}
```yaml
tasks:
  shell_example:
    image: ubuntu
    shell: bash
    cmds:
      - echo $RANDOM

```
{% endcode %}

{% hint style="info" %}
### File permission

On Linux hosts a container task runs as your `uid:gid`, so files it generates on
mounted paths come back owned by you rather than by `root`. To avoid permission
conflicts on the mount points themselves, hammerkit `chown`s the working directory
and each mount to your `uid:gid` before the task runs.

The blast radius is small and deliberate: the `chown` is **not** recursive, so it
only re-owns those top-level directories — files already inside an image (for
example pre-baked, root-owned content) are left untouched. On macOS and Windows the
Docker Desktop VM handles the uid mapping, so this step is skipped entirely.
{% endhint %}
