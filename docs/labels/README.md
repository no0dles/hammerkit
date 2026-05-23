---
description: Labels allow to group and categorize your tasks.
---

# Labels
A label is a key value pair. 
They can be defined on tasks or build files.

Labeling your tasks will allow you to run multiple task groups or exclude specific tasks.

## Example use cases
The following use cases are just some examples to showcase some of the potential usage for labels.

### Separating tasks by area
Labels can be useful to seperate tasks. 
For example if you share one build file for different parts of your application or in case of a bigger project/monorepo.
Add a `project` label to your tasks and be able to build projects independant with a single command `task -f project=a` or `task -f project=b`

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
Labels can be used to separate your tasks in your CI.
In a CI environment where there are two runners, one that runs macOS and the other linux.
With the goal to use the macOS host only for the ios related code and the rest should run on linux.
Add a `platform=ios` label to the task that require macOS and configure your ci to run `task -f platform=ios` on the mac host and `task -e platform=ios` on the linux host. 

If there are tasks dependencies between the platform tasks, take a look at [store / restore](../cli/store-restore.md). 
These can be used to store and restore generated outputs from tasks, work as well with the label arguments `task store -e platform=ios` and help to move data/cache between hosts.

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
Simplify your workflow by grouping task together.
Run one command for multiple tasks that have no dependency otherwise.
For example a `task` label for either developing or publishing. 
`task -f dev` will start your api server with the frontend development watch build. 
`task -f publish` will upload your container image to docker hub and build and upload to the staging environment.

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
