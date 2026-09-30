---
description: >-
  Print the build graph — tasks, services and their deps/needs — as mermaid or
  graphviz dot.
---

# Graph

`hammerkit graph [task]` serializes the build graph without running anything.
Tasks are boxes, services are rounded nodes; a solid edge is a `deps` edge, a
dotted edge is a `needs` edge. Paste the mermaid output into a GitHub comment or
markdown file to render it.

```bash
hammerkit graph e2e
```

```
graph TD
  t0["build"]
  t1["e2e"]
  t2["install"]
  s0(["db"])
  t0 --> t2
  t1 -.-> s0
  t1 --> t0
```

```bash
hammerkit graph --format dot | dot -Tsvg > graph.svg
```

A cycle is reported as a warning after the graph is printed.

## Options

```
Usage: hammerkit graph [options] [task]

Options:
  -f, --filter <labels...>   filter task and services with labels
  -e, --exclude <labels...>  exclude task and services with labels
  --env <name>               environment
  --format <format>          output format (choices: "mermaid", "dot", default: "mermaid")
```
