---
description: >-
  Includes are similar to references with the key difference, the current work
  directory. For included build files the current work directory is relative to
  where it got included.
---

# Includes

Includes are ideal to define repetitive tasks and reuse them in multiple places. 
Reference files can be used to split up tasks, but they keep the current work directory fixed to the directory they are placed. 
For includes the current work directory is dynamically adjusted to where it got included from.

The following example is a typescript monorepo with two projects `a` and `b`. Project `b` is dependent on `a` and both require to keep the dependencies up-to-date before compiling the source code.

{% code title="build.npm.yaml" %}
```yaml
tasks:
  install:
    cmds:
     - npm install
    src:
      - package.json
      - package-lock.json
    generates:
      - node_modules
```
{% endcode %}

For the npm install an include is used, because there is for each project a package.json, but the task definition can be reused.

{% code title="project/a/.hammerkit.yaml" %}
```yaml
tasks:
  build:
    deps: [npm:install]
    cmds:
      - node_modules/.bin/tsc -b

includes:
  npm: ../../build.npm.yaml
```
{% endcode %}

Includes are used for the [task dependency](../task/dependencies.md) of the build task and ensures that the node\_modules is installed before.

{% code title="project/b/.hammerkit.yaml" %}
```yaml
tasks:
  build:
    deps: [npm:install, a:build]
    cmds:
      - node_modules/.bin/tsc -b

references:
  a: ../a
            
includes:
  npm: ../../build.npm.yaml
```
{% endcode %}

In the build file of project `b`, the include for the npm install task is used as well. 
An additional [reference](references.md) to `a` and a [task dependency](../task/dependencies.md) to a:build ensures that project `a` will be built first, before project `b` get compiled.

## references vs. includes vs. extend — when to use which

All three reuse definitions, but they differ in *what* they reuse and *where it
runs*:

| | What it pulls in | Working directory | Use it when |
|---|---|---|---|
| **[references](references.md)** | A whole other build file (its tasks + services) | The **referenced** file's own directory | The other file is its own project (a sub-package you also want to build in place). |
| **includes** | A whole other build file | The **including** file's directory | You want to reuse a task *definition* and run it here — the same `install`/`build` template across every package. |
| **[extend](../task/extending.md)** | A single task, as a base template | The current task's file | One task is almost another, with a tweak or two. |

A common monorepo setup combines them: an `includes` brings in a shared
`build.npm.yaml` so each package runs `install` in its own directory, while
`references` wire up cross-package build order. See the
[monorepo guide](../guides/monorepo.md).
