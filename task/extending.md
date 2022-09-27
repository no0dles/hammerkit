---
description: >-
  A task can be used as a base template and extended. This is intended to reduce
  duplicate task definitions.
---

# Extending

Extending tasks can save a lot of duplicated tasks in bigger projects and monorepos. With the task `extend` property a base configuration can be used as a template.&#x20;

The following sections and examples use the two predefined tasks in the`build.tsc.yaml` file.&#x20;

{% code title="build.tsc.yaml" %}
```yaml
tasks:
  install:
    src:
      - package.json
      - package-lock.json
    generates:
      - node_modules
    cmds:
      - npm ci
      
  build:
    deps: [ install ]
    src:
      - tsconfig.json
      - src
    cmds:
      - node_modules/.bin/tsc
    generates:
      - dist
```
{% endcode %}

### Extend a task

Extending the `tsc:build` task will use all defined properties as a base. If nothing else is defined, it will be an exact copy with the working directory of the current build file.

{% code title="build.yaml" %}
```yaml
tasks:
  build:
    extend: tsc:build
    
includes:
  tsc: ./build.tsc.yaml
```
{% endcode %}

### Override properties in an extend

Every extended task can override defined or undefined properties. In this example the dependency gets cleared and runs without a dependency to the `install` task.

{% code title="build.yaml" %}
```yaml
tasks:
  build:
    extend: tsc:build
    deps: []
    
includes:
  tsc: ./build.tsc.yaml
```
{% endcode %}
