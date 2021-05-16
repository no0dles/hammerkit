# Hammerkit

![License](https://img.shields.io/npm/l/hammerkit)
![GitHub Workflow Status](https://img.shields.io/github/workflow/status/no0dles/hammerkit/master)
![npm](https://img.shields.io/npm/v/hammerkit)

## Installation

```npm i -g hammerkit```

## Getting started

The buildfile is usually named `build.yaml` and defines a list of tasks either defined in the file itself or by referencing them from other build files.

```yaml
tasks:
  install:
    description: install node modules
    cmds:
	 - npm install
```

A task contains a list of commands which are executed in order.

```yaml
tasks:
  install_and_install:
    cmds:
	 - npm install
	 - npx tsc
```

Tasks can have dependencies to each other and those are enforce to run first.

```yaml
tasks:
  install:
    cmds:
	 - npm install
	
  build:
    deps: [install]
    cmds:
	 - npx tsc
```

To prevent duplicate work, a list of source and output files can be defined. These will be checked before each execution and if the source files did not change since last time, it will skip the task. Note: If a dependency task has changed or does not have defined source files, caching will not work and run the task every time.

```yaml
tasks:
  install:
    src:
    - package.json
    - package-lock.json
    cmds:
	 - npm install
    generates:
	 - node_modules
	
  build:
    deps: [install]
    src:
    - src
    - tsconfig.json
    cmds:
	 - npx tsc
```

The source list can be files or folders which will be checked recursively. It's also possible to use glob patterns (**)

```yaml
tasks:
  build:
    src:
    - src/**/*.ts
    - tsconfig.json
    cmds:
	 - npx tsc
```

Environment variables can also be defined in the buildfile or the task directly.

```yaml
envs:
  NODE_VERSION: 14.16.0

tasks:
  version:
  	 envs:
  	   NODE_ENV: production
    cmds:
	 - npm run build
```

For the more sensitive environment variables .env files can be used or they can be passed in. If an environment variable is defined like the version number in following example, it's presence is checked before execution and if missing aborted.

```
NPM_TOKEN=supersecret
```

```yaml
tasks:
  publish:
    envs:
      VERSION: $VERSION
    cmds:
	 - npm publish
```

A Task can also run inside a docker container. 

```yaml
tasks:
  install:
    image: node:14.16.0
    cmds:
	 - npm install
```

For docker tasks the source and output files are mounted into the container. If there are any additional files which are neither of them, they can be defined with mounts.

```yaml
tasks:
  install:
    image: node:14.16.0
    generates:
      - node_modules
    src:
      - package.json
      - package-lock.json
    mounts:
      - $PWD/.npm:/.npm
      - $PWD/.config:/.config
    cmds:
	 - npm install
```

Dependent tasks source and output files will also be mounted, as they could be depandant. 
 
```yaml
tasks:
  install:
    image: node:14.16.0
    generates:
      - node_modules
    src:
      - package.json
      - package-lock.json
    mounts:
      - $PWD/.npm:/.npm
      - $PWD/.config:/.config
    cmds:
	 - npm install

  build:
    deps: [install]
    image: node:14.16.0
    generates: [dist]
    src: [src]
    cmds:
      - node_modules/.bin/tsc
```

Buildfiles can be referenced from other buildfiles. 

```yaml
tasks:
  build:
    deps: [a:build, b:build]
    
references:
  a: project/a/build.yaml
  b: project/b/build.yaml
```

To prevent duplicate tasks, there are also includes. Those are similar to references, but a different workdir behavior. For tasks in a referenced buildfile the workdir is relative to the build file where the task is defined. For includes the workdir is relative where it got included.


```yaml
tasks:
  build:
    deps: [npm:install]
    cmds:
    - tsc
    
includes:
  npm: utils/build.npm.yaml
```

There is also an extend functionality, to keep repetition at a minimum. With an extend, a task can be reused and also adjusted if needed.

build.yaml

```yaml
tasks:
  build:
    deps: [npm:install]
    extend: tsc:build    
    
includes:
  npm: utils/build.npm.yaml
  tsc: utils/build.tsc.yaml
```

utils/build.tsc.yaml

```yaml
tasks:
  build:
     image: node:14.16.0
     src: [src, tsconfig.json]
     generates: [dist]
     cmds:
       - node_modules/.bin/tsc -b
```

## Roadmap


- [x] use env variables from the shell, .env files or place them directly into the build file
- [x] run commands inside docker images
- [x] include/reference other build files
- [x] define dependencies between tasks
- [x] define source/generates to prevent unnecessary work
- [x] store/restore generated outputs for caching
- [x] clean command to remove all outputs
- [x] validate command to check if the build file is correct
    - [x] check for invalid yaml
    - [x] check cycles
    - [x] warn about missing descriptions
    - [x] warn about missing src files
    - [x] warn about missing env variables

- [x] mounts outside of container work dir
- [x] dynamic deep of container work dir
- [x] ignore .hammerkit folder in cache
- [x] support glob for sources
- [x] prevent duplicate execution on multiple deps
- [x] dependant cache and volumes
- [x] rerun task when content changes, even when its cached
- [x] add $PWD mounts
- [ ] continous/watch tasks
- [ ] services
- [ ] docs
- [ ] windows/osx test runs

## Release
```
npm version patch|minor|major
npm publish
```
