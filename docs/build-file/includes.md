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

The following example is a typescript monorepo with two projects `a` and `b`. Project `b` is dependant on `a` and both require to keep the dependencies up-to-date before compiling the source code.

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

The include is used for the [task dependency](../task/dependencies.md) of the build task and ensures that the node\_modules is installed before.

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
