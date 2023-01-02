---
description: >-
  Store and Restore generated files and folders. Increase the performance on
  your CI.
---

# Store / Restore

The store/restore commands are intended to be used in a CI system. The store command requires a destination folder, where the all generated folders and files are moved for later recovery. Restoring previous state can give a performance boost to your CI workflows, because it can leverage caching from your tasks over different pipelines.

### Example workflow

To demonstrate the behavior we use the following example below. A simple node typescript project, that requires to install npm dependencies and compile the typescript source code.

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

The CI system uses the build task to `build` on every commit. The goal of the store/restore functionality is to prevent unnecessary work in the CI. Together with the caching from hammerkit, the build command will be skipped if nothing regarding source code has changed. The npm install will be skipped as well and the node\_modules folder will be restored if nothing has changed inside the `package.json` and `package-lock.json` file.

### Saving state

```
hammerkit store cache
```

&#x20;After the store command completed, the hammerkit cache including all files from tasks that use the `generate` property are saved in the given destination folder. The folder can now be cached with the available caching mechanism in your CI.

### Restoring state

Before running the required tasks in your CI workflow the state should be restored. Make sure your CI caching mechanism restores the previous saved cache and then restore it with hammerkit.

```
hammerkit restore <cache_dir>
```

### Example with Gitlab CI

This example uses the gitlab ci caching to speed up the build time of the `build` command. For further details, take a look at the [demo repository](https://gitlab.com/pascalbe/hammerkit-typescript-restore-demo).

{% code title="gitlab-ci.yml" %}
```yaml
before_script:
  - npm i -g hammerkit

build:
  image: node:14.16.0
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

###
