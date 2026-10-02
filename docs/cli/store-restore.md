---
description: >-
  Store and restore generated files and folders to speed up your CI.
---

# Store / Restore

The store/restore commands are intended for CI systems. The store command takes a destination folder, into which all generated files and folders are moved for later recovery. Restoring the previous state speeds up your CI workflows, because task caching then works across pipeline runs.

### Example workflow

To demonstrate the behavior, we use the following example: a simple Node.js TypeScript project that installs npm dependencies and compiles the TypeScript source code.

{% code title=".hammerkit.yaml" %}
```yaml
tasks:
  install:
    src:
      - package.json
      - package-lock.json
    cmds:
      - npm ci
    generates:
      - node_modules
      
  build:
    deps: [install]
    src:
      - src
      - tsconfig.json
    generates:
      - dist
    cmds:
      - node_modules/.bin/tsc -b
```
{% endcode %}

The CI system runs the `build` task on every commit. The goal of store/restore is to prevent unnecessary work in CI. Together with hammerkit's caching, the build task is skipped if the source code hasn't changed. The npm install is skipped as well, and the node\_modules folder is restored, if `package.json` and `package-lock.json` are unchanged.

### Saving state

```
hammerkit store cache
```

After the store command has completed, the hammerkit cache, including all files from tasks that declare `generates`, is saved in the given destination folder. The folder can then be cached with your CI's caching mechanism.

### Restoring state

Restore the state before running the required tasks in your CI workflow: let your CI's caching mechanism restore the previously saved folder, then restore it with hammerkit.

```
hammerkit restore <cache_dir>
```

### Example with GitLab CI

This example uses GitLab CI caching to speed up the build time of the `build` command. For further details, take a look at the [demo repository](https://gitlab.com/pascalbe/hammerkit-typescript-restore-demo).

{% code title=".gitlab-ci.yml" %}
```yaml
before_script:
  - npm i -g hammerkit

build:
  image: node:24
  cache:
    key: ${CI_COMMIT_REF_SLUG}
    paths:
      - cache
    policy: pull-push
  script:
    - hammerkit restore cache
    - hammerkit build
    - hammerkit store cache

```
{% endcode %}
