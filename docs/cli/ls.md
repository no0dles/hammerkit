---
description: Inspect the tasks and services available in a build file.
---

# ls

`ls` prints every task and service hammerkit can see, including the ones pulled in
through [references](../build-file/references.md) and
[includes](../build-file/includes.md). It's the fastest way to understand a repo
you just cloned — before guessing task names.

```bash
hammerkit ls
```

## Example output

```
Services:
• postgres
   ports: 127.0.0.1:5432 -> 5432
   image: postgres:16-alpine

Tasks:
• install
   image: node:22-alpine
   labels: stage=build
   src: package.json package-lock.json
   generates: node_modules
• api
   needs: postgres
   deps: install
   image: node:22-alpine
   labels: stage=run app=example
   src: index.js config.json package.json package-lock.json
   generates: node_modules
```

Each entry shows the image (or nothing, for a local task), labels, sources,
generated outputs, and the `deps`/`needs` wiring — the same fields you set in the
build file.

## Options

```
Options:
  -f, --filter <labels...>   filter task and services with labels
  -e, --exclude <labels...>  exclude task and services with labels
  -h, --help                 display help for command
```

The label options take `key=value` pairs, so you can scope the listing to one part
of a monorepo, for example `hammerkit ls -f project=api`. See
[labels](../labels/README.md).
