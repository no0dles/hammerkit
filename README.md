<h1 align="center">
  <img src="docs/hammerkit.png" alt="hammerkit" width="250">
</h1>
<h2 align="center">Hammerkit</h2>

<p align='center'>
  <img alt='build' src='https://img.shields.io/github/workflow/status/no0dles/hammerkit/master'>
  <img alt='license' src='https://img.shields.io/npm/l/hammerkit'>
  <img alt='npm' src='https://img.shields.io/npm/v/hammerkit'>
</p>

## About

Hammerkit is a build tool intended to build software projects in containers locally and in a CI. The advantage of containerized builds are:
- the build tools used from the container image are the same across all machines.
- the build process is isolated since every file in the container has to be declared as a source or an output. Therefore side effect should never occur.

There are a lot of containerized CI systems that allow writing containerized builds today, but they lack some features hammerkit tries to solve:
- they are often not usable during development on your local machine, so you have either maintain two build scripts or wrap one of them in the other.
- they mount the entire repository into the container and can therefore side effect can reduce reliability
- some of them do not allow switching images during build steps. Requiring to maintain a large build image, that contains all tools needed to build to software.

Additionally hammerkit tries to reduce complexity of build caching in CI systems. Usually you define a directory that is being cached and restored before and after the CI build. That's totally fine for smaller project where there are not that many directories to cache. The bigger the project gets, the more effort it is, to keep all directories up to date.

Hammerkit on the other hand knows the source and output files of each build step and can therefore compact the build results into a single directory. Making it easy to being cached. Once restored, hammerkit can detect what's changed since last time and only build the changes.

<p align='center'>
    <a href="https://no0dles.gitbook.io/hammerkit">
        <img src="docs/read_the_docs.png" alt="docs">
    </a>
</p>

## Installation

### Yarn/npm
```npm i -g hammerkit```

### Homebrew
```
brew tap no0dles/hammerkit
brew install hammerkit
```

### Gitlab CI
```
variables:
  DOCKER_DRIVER: overlay2

services:
  - docker:19.03.0-dind

build:
  image: no0dles/hammerkit
  script:
    - hammerkit build
```

### Github Action
```
jobs:
  build:
    runs-on: ubuntu-18.04
    steps:
      - name: Checkout
        uses: actions/checkout@v2
      - uses: actions/setup-node@v2
        with:
          node-version: '14'
      - uses: no0dles/hammerkit-github-action@v1.3
```

## Roadmap
The following topics are planned to be addressed in the future.

### Services
Task sometimes require some service to run.
For example a database, which is required to run an api or an integration test.
The goal will be to define those and hammerkit spins them up for the task and shuts them down if not needed.

### Distributed caching
Distribute local cache, so other developers and the CI can use already build up caches.
The goal will be general performance improvements on CI and local development.

### Distributed computing
Offload complex and compute intense tasks to remote hardware.
The goal will be use the power of cloud computing, with very less configuration.

### Platform requirements
Define tasks that require a specific platform for local tasks.
The goal will be to either skip local tasks where platform requirements are not met or execute them on a remote machine.


## Release
```
npm version patch|minor|major|prerelease
git push origin --tags
```
