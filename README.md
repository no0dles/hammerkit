# Hammerkit

![License](https://img.shields.io/npm/l/hammerkit)
![GitHub Workflow Status](https://img.shields.io/github/workflow/status/no0dles/hammerkit/master)
![npm](https://img.shields.io/npm/v/hammerkit)

## Installation

```npm i -g hammerkit```

## Getting started

```hammerkit init```

## Usage
```hammerkit <taskName>```

## Features

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
- [ ] docs
- [x] mounts outside of container work dir
- [ ] dynamic deep of container work dir
- [ ] windows/osx test runs
- [x] ignore .hammerkit folder in cache
- [x] support glob for sources
- [x] prevent duplicate execution on multiple deps
- [x] dependant cache and volumes
- [x] rerun task when content changes, even when its cached
