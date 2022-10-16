---
description: >-
  A task can be contained inside a container. This improves
  cross-platform support for your build files and reduce the list locally
  installed tools that are required to run your tasks.
---

# Container

Every task can run inside a container. Everything thats needed is to set an `image` property on your task.

{% code title="build.yaml" %}
```yaml
tasks:
  install:
    image: node:14.16.0
    cmds:
      - npm install
```
{% endcode %}

This example will run an `npm install` command inside a container with the image `node:14.16.0`. But the container has no access to the local files, nothing will get installed. In order to access your project files sources, generates and mounts can be used.

### Adding source files/folders

All source files and folders will be mounted on container start and can be accessed inside the container.

{% code title="build.yaml" %}
```yaml
tasks:
  install:
    image: node:14.16.0
    src:
      - package.json
      - package-lock.json
    cmds:
      - npm install
```
{% endcode %}

### Adding output files/folders

The installed node\_modules will be saved inside the container file system, if those files and folders are needed after the end of the execution a `generate` property should be added.

```yaml
tasks:
  install:
    image: node:14.16.0
    src:
      - package.json
      - package-lock.json
    generates:
      - node_modules
    cmds:
      - npm install
```

### Adding mounts

For other files and folders that do not belong into sources/generates mounts can be used. They can be relative, absolute or relative to the user directory.

{% code title="build.yaml" %}
```yaml
    tasks:
      install:
        image: node:14.16.0
        src:
          - package.json
          - package-lock.json
        generates:
          - node_modules
        mounts:
          - relative/path
          - /some/absolute/path
          - $PWD/.npm:/.npm
        cmds:
          - npm install
```
{% endcode %}

{% hint style="info" %}
Each source and generate of all dependencies get mounted into container automatically. This behavior should reduce long list of mounts and should help with the consistency of tasks.&#x20;
{% endhint %}

### Execution shell

Each command will be executed per default within a `sh` shell. The shell can also be override by adding a `shell` property to the task.

{% code title="build.yaml" %}
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

Each command in a container will be executed with the same pid/gid as on the local system. This ensures that all generated files and folders that are mounted to the container will end up with the same pid/gid. To ensure that there is no permission conflict, hammerkit will set the owner of the current work directory including all mounts to the current pid/gid before each task execution.
{% endhint %}
