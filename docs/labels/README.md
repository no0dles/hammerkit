---
description: Labels let you group and categorize your tasks.
---

# Labels
A label is a key-value pair.
Labels can be defined on tasks or on build files.

Labeling your tasks lets you run multiple task groups or exclude specific tasks.

## Example use cases
The following examples show some of the ways labels can be used.

### Separating tasks by area
Labels can be useful to separate tasks,
for example if you share one build file across different parts of your application, or in a bigger project or monorepo.
Add a `project` label to your tasks to build projects independently with a single command: `hammerkit -f project=a` or `hammerkit -f project=b`.

{% hint style="info" %}
Label filters are always given as `key=value`. A bare `-f project` (key only) is
rejected. Use `-f` (`--filter`) to keep only matching tasks and `-e` (`--exclude`)
to drop them; both can be repeated or take multiple values.
{% endhint %}

```yaml
tasks:
  build-a:
    deps: [install-a]
    labels:
      project: a
    cmds:
      - tsc -b ./project/a
  
  test-a:
    deps: [install-a]
    labels:
      project: a
    cmds:
      - jest

  build-b:
    deps: [install-b]
    labels:
      project: b
    cmds:
      - tsc -b ./project/b
```

### Separate by platform
Labels can be used to split your tasks across CI runners.
For example, a CI environment might have two runners, one on macOS and one on Linux, and the macOS host should only run the iOS-related code.
Add a `platform=ios` label to the tasks that require macOS, and configure your CI to run `hammerkit -f platform=ios` on the macOS host and `hammerkit -e platform=ios` on the Linux host.

If tasks on the two platforms depend on each other, use [store / restore](../cli/store-restore.md) to move generated outputs and cache state between the hosts.
Both commands accept label filters too, for example `hammerkit store cache -e platform=ios`.

```yaml
tasks:
  build-ios:
    labels:
      platform: ios
    cmds:
      - xcodebuild ...
  
  build-api:
    image: node
    cmds:
      - tsc -b

  publish-testflight:
    deps: [build-ios]
    labels:
      platform: ios
    cmds:
      - altool upload-app ...
```


### Group by purpose
Simplify your workflow by grouping tasks: run one command for multiple tasks that don't otherwise depend on each other.
For example, use a `task` label for developing or releasing.
`hammerkit -f task=dev` starts your API server together with the frontend development build.
`hammerkit -f task=release` pushes your container image to Docker Hub and builds and uploads the frontend to the staging environment.

```yaml
tasks:
  frontend:
    labels:
      task: dev
    cmds:
      - ng serve

  api:
    labels:
      task: dev
    cmds:
      - dotnet run
  
  publish-s3:
    labels:
      task: release
    cmds:
      - ng build
      - aws s3 cp dist/frontend s3://staging-web
  
  publish-api:
    labels:
      task: release
    cmds:
      - docker build ...
      - docker push ... 
```
