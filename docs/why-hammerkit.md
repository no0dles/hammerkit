---
description: What hammerkit gives you that a plain task runner doesn't.
---

# Why hammerkit

Most projects already have *some* way to run builds: a `Makefile`, npm scripts, a
`Taskfile`, or a pile of CI YAML. Hammerkit exists because those tend to drift
apart from each other and from what runs in CI. Its job is to be **one build
definition that runs the same way everywhere**.

## The five reasons that matter

### 1. One config for local *and* CI

A hammerkit build file is the single source of truth. The command you run on your
laptop — `hammerkit build` — is the exact command CI runs. There is no second
pipeline definition to keep in sync, and no "works on my machine / breaks in CI"
gap, because it is literally the same build.

### 2. No repeated, tool-specific configs

A typical repo accumulates a `Makefile`, npm scripts, a Dockerfile per step, and a
CI workflow that re-encodes all of it. Hammerkit replaces that sprawl: one file
declares the tasks, their inputs, their outputs, and the image each runs in.
Reducing config duplication is a feature, not a side effect.

### 3. Runs on every platform

There is no coupling to GitHub Actions, GitLab CI, or any single provider. The
same build runs anywhere a container does — your macOS laptop, a colleague's
Linux box, a Windows machine with WSL, or any CI runner. Move providers without
rewriting your build.

### 4. Containers make builds repeatable

When a task declares an `image`, its tools come from that image — not from
whatever happens to be installed on the machine. That means you don't have to
install Node, the .NET SDK, Helm, and the AWS CLI on every developer's laptop and
every runner; you just need a container engine. Each task can even use a
*different* image, so you're not maintaining one giant "build everything" image.

### 5. Effort is shared through caching

Hammerkit knows the `src` (inputs) and `generates` (outputs) of every task. So it
can:

* **skip** a task when its inputs are unchanged, and
* **share** the cached result between machines and CI runs through a pluggable
  cache backend (local directory or an S3-compatible bucket).

The bigger the project, the more this pays off: a `git clone` on a fresh runner
can restore outputs another machine already produced instead of rebuilding them.
That saves wall-clock time *and* compute cost — see [caches](build-file/caches.md)
and [task caching](task/caching.md).

## Compared to other tools

| Capability | Make | npm scripts | Taskfile | Earthly | **hammerkit** |
|---|---|---|---|---|---|
| Same definition runs locally **and** in CI | ⚠️ manual | ⚠️ manual | ⚠️ manual | ✅ | ✅ |
| Runs steps in containers | ❌ | ❌ | ❌ | ✅ | ✅ (per-task `image`) |
| Also runs directly on the host (no container) | ✅ | ✅ | ✅ | ❌ | ✅ (omit `image`) |
| Tracks declared inputs **and** outputs | ⚠️ targets | ❌ | ⚠️ sources | ✅ | ✅ (`src` / `generates`) |
| Skips unchanged work | ⚠️ mtime | ❌ | ✅ checksum | ✅ | ✅ (checksum default) |
| Shares cache across machines / CI | ❌ | ❌ | ❌ | ✅ | ✅ (local + S3 backends) |
| Runs independent work in parallel | ⚠️ `-j` | ❌ | ✅ | ✅ | ✅ |
| Built-in services (e.g. a database) for a task | ❌ | ❌ | ❌ | ⚠️ | ✅ (`needs`) |
| Provider-agnostic (no CI lock-in) | ✅ | ✅ | ✅ | ✅ | ✅ |

> ⚠️ = possible but only with manual wiring or partial support.

## The principles behind it

These are the values hammerkit is designed around:

* **Local-first.** A build tool that only runs in CI is broken; hammerkit must be
  usable on a developer's laptop.
* **Platform-agnostic.** No coupling to a single CI provider — the same build runs
  anywhere a container does.
* **One config, many tools.** A single build file replaces N tool-specific configs.
* **Caching reduces waste, not just time.** Smart, distributed caching saves
  compute — that matters for cost and footprint, not only speed.
* **Stable contracts.** The CLI and build-file schema are contracts; breaking them
  is a deliberate, versioned decision.

Ready to try it? Head to [getting started](getting-started.md), then the
[tutorial](tutorial.md).
