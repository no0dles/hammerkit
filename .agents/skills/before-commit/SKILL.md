---
name: before-commit
description: Pre-commit checklist for the hammerkit repo. Run the same gates CI enforces — prettier, eslint, tsc build, and the unit suite — before committing, so a push doesn't fail the build/test workflows. Use before any git commit in this repository.
---

# Before committing (hammerkit)

Run these locally before `git commit`/`git push`. Each maps to a GitHub Actions
gate; passing them locally is the difference between a green push and a red one.
Run from the repo root.

## 1. Prettier — the most common CI break

The `build` workflow runs `prettier --check 'src/**'`, and it is **strict**: a
single unformatted file fails the entire `build` workflow (even if your own
changes are clean — it checks all of `src/`).

```bash
node_modules/.bin/prettier --check 'src/**'
```

If it reports issues, fix them:

```bash
npm run format   # prettier -w src/** && eslint . --fix --ext .ts
```

Style is enforced: no semicolons, single quotes, 120 cols, 2-space indent,
trailing commas `es5`.

## 2. ESLint

```bash
npm run lint     # eslint . --ext .ts
```

Note `no-console: error` — never write to `console.*` in `src/`. Route output
through the `Environment` (`stdout`/`stderr`/`console`/`status`).

## 3. Typecheck / build

```bash
npm run build    # tsc -b tsconfig.json
```

This typechecks spec files too, so it catches test-only type errors.

## 4. Unit tests — mirror CI with `CI=true`

```bash
CI=true npm test
```

Run with `CI=true`. In CI the container/k8s tests gate themselves to a no-op
when their env flag is unset (see `src/testing/requires-*.ts`); **without**
`CI=true` those same tests try to talk to Docker/Kubernetes locally and fail.
The unit suite (`jest`) excludes `src/testing/integration/`, so it needs no
Docker.

Single test while iterating:

```bash
node_modules/.bin/jest src/path/to/file.spec.ts -t "test name"
```

## 5. Integration tests — only when you touched docker / k8s / execution

These need a running Docker daemon (and are slow). They are **not** required for
most commits; the self-hosted `integration` workflow covers them. Run locally
only if your change affects container/k8s execution:

```bash
# Docker must be running. CI runs this --runInBand.
LINUX_CONTAINERS=true npm run test:integration -- --runInBand
```

Add `CLUSTER_NAME=<kube-context>` to also exercise the kubernetes specs.

## Cross-platform note

The `test` workflow runs the unit suite on **ubuntu, windows, and macos**, plus
a `macos-containers` job. Keep changes portable:

- Build paths with `path` helpers; in tests, make separator-sensitive
  expectations native (`val.split(posix.sep).join(sep)`) rather than hardcoding
  `/` — see `src/planner/utils/parse-work-mount.spec.ts`.
- File-watch + repeated process-spawn tests are unreliable on Windows hosted
  runners; the watch-restart cases in `src/executer/execute.spec.ts` are gated
  off win32. If you add similar tests, expect to gate them too.

## One-liner

```bash
node_modules/.bin/prettier --check 'src/**' && npm run lint && npm run build && CI=true npm test
```

If all four pass, the `build` and `test` workflows should pass on push.
