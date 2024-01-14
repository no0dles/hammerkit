# Release 1.4.0

A short retro about the made changes and findings

## Log Modes

The new log implementation supports three new modes. 
`interactive` will be the default for regular use, 
`live` is used if a CI environment is detected. 
The default can be changed with the `-l`, `--log` flag.

### Interactive

Print the most recent log for each running task and see always an overview of the overall progress for all dependencies. 
Failed tasks get printed in full, after completion.

![](./hardlink.gif)

### Live

Print all logs from all task instantly. 
Get feedback fast, but makes reading logs harder, if there are many things running in parallel.

![](./live.gif)

### Grouped

Print all logs after a task has finished. 
Feedback is delayed, but not interrupted by other tasks.

![](./grouped.gif)

## Watch improvements

Before 1.4.0 a task could be marked as watchable with `watch: true`. 
When executing the task, the source files were watched for changes and the task got restarted on every file change event.

With the new release the `watch` flag can be removed from the build file and instead be passed to the cli. 
Every task with source files can be watchable and therefore the flag is not needed anymore. 
The new implementation also detects changes on dependant tasks and restarts them if needed. 
This change allows to watch over multiple build steps and reduces the need of manual interaction.

As a simple showcase, let's take a quick look at a node server application. 
It requires some npm packages to be installed. 
The package list is defined in the `package.json` file and installed with `npm install`. 
After installation the api can be started. 
If a new package gets added to the `package.json` it requires another `npm install` before restarting the api to take advantage of the new package.

With the following build file all the mentioned steps are executed by running `hammerkit api --watch`. 
When the content of the package.json gets modified, it will first install the npm packages and then restart the api. 
Removing the need for any manual interaction.

{% code title=".hammerkit.yaml" %}
```yaml
tasks:
  install:
    image: node:16.6.0-alpine
    mounts:
      - $PWD/.npm:/.npm
      - $PWD/.config:/.config
    cmds:
      - npm install
    generates:
      - node_modules
    src:
      - package.json
      - package-lock.json

  api:
    image: node:16.6.0-alpine
    deps: [install]
    ports:
      - 8080
    src:
      - src
    cmds:
      - node src/index.js

```
{% endcode %}

## Docker performance improvements

The overall performance on file heavy tasks could be improved a lot by switch for generated files from mounts to volumes. 
Tasks like `npm install` with several thousands files lead to unresponsiveness in the docker api and required restarts. 
Debugging and reading the docker-for-mac/windows [user manual](https://docs.docker.com/desktop/mac/#file-sharing) lead to the conclusion **source files get mounted, generates use volumes**.

The change improved the stability and execution time, but required some changes to the store/restore functionality.

## Moved cache location

Hammerkit keeps track of all used source files and task definitions. 
This is used to identify, if a task can be skipped because the source has not changed and therefore the old output should still be the same. 
These cache files were located in the same directory as the build file in a `.hammerkit` subfolder.

Those files needed to be excluded with from git, build steps and IDE's, because they were usually located on the same level as the source code. 
To reduce those kind of issues, they were moved into the user directory. 
Removing the need for special treatments.

## Automated test runner for macOS and Linux

To fully test hammerkit, a running docker daemon is required. 
For macOS and Linux there is now GitHub Action, that tests all `examples` in the repository for every merge request. 
Windows is hopefully coming soon as well, but even tough there are windows runners available on GitHub, the docker setup requires still some work.

## Update node to v16 and make use of the AbortController

During testing hammerkit on Linux, some examples ended in an `unhandledPromise` error. 
After some investigation, the reason could be pinned down to the usage of the `Defer` class, that was used a lot in hammerkit. 
The Defer class was a wrapper, to reduce repeating code handling callback results. 
The issue was that the `Defer` class created a promise with the default constructor without adding a catch handler. 
Since the `Defer` pattern is not a recommended approach anymore (very well explained [here](https://stackoverflow.com/questions/34971078/how-to-replace-promise-defer-with-new-promise)) and in newer versions of node `unhandledPromise` result in process failures, the removable was a no-brainer.

The `Defer` class was mainly used for callback functions and the cancellation logic of tasks. 
A Defer got resolved when the user pressed Ctrl-C and the task execution handler ended the task early when that promise got resolved.

The `AbortController` was the perfect replacement and has just made it into the [Web Spec](https://dom.spec.whatwg.org/#interface-abortcontroller) and is available in node environments since [v15](https://nodejs.org/api/all.html#globals\_class\_abortcontroller).

## Adding best practices

In the repository a new folder `best-practices` got added with tooling specific examples. 
The build files are intent to be project independent and showcase how popular build tools should be used together with hammerkit.

## Next release

The next release will focus on adding a service concept. 
Services will be a solution to allow long-running tasks like databases to be connected with the existing tasks.

The goal will be to find an efficient way of spinning up and shutting them down, so they only run, when they are needed by a task actively. 
That will require also a concept of how to deal with readiness detection of services.
