# AGENTS.md

Guidance for AI coding agents (Claude Code, Cursor, Copilot, etc.) working in this repository.

## What this is

Hammerkit is a containerized build tool (CLI distributed as `dist/index.js`). It reads a `.hammerkit.yaml` build file, plans a graph of tasks and services, and executes them locally, in Docker, or on Kubernetes. Source/output files are explicitly declared per task, which is what enables hammerkit's incremental caching and "store/restore" workflow for CI.

User-facing docs live at https://no0dles.gitbook.io/hammerkit/ (see [SUMMARY.md](SUMMARY.md) for the structure).

## Commands

- `npm run build` — `tsc -b tsconfig.json`, outputs to `dist/`
- `npm test` — runs jest across `src/**/*.spec.ts`. Tests run with `maxConcurrency: 1` and a 45s timeout; expect a full run to be slow.
- `npm run lint` / `npm run format` — eslint / prettier+eslint --fix.
- Single test: `node_modules/.bin/jest src/path/to/file.spec.ts -t "test name"`. CI uses `jest --runInBand`.

### Test environment flags

Many integration tests in [src/testing/integration/](src/testing/integration/) gate themselves on env vars (see [requires-linux-containers.ts](src/testing/requires-linux-containers.ts), [requires-windows-containers.ts](src/testing/requires-windows-containers.ts), [requires-kubernetes.ts](src/testing/requires-kubernetes.ts)). In CI, when the flag is unset the test is replaced with a no-op:

- `LINUX_CONTAINERS=true` — enable docker/linux-container tests (set on Linux + macOS in CI)
- `WINDOWS_CONTAINERS=true` — enable windows-container tests
- `CLUSTER_NAME=<ctx>` — enable kubernetes tests (CI uses minikube)
- `VERBOSE=true` — verbose test output

Locally these gates are bypassed (`isCI` is false), so tests will attempt to talk to Docker/k8s and fail if those aren't available. Use the env flags to opt-in selectively.

## Architecture

The CLI flows roughly: **parse → plan → schedule → execute**. Knowing this pipeline is the fastest way to orient in the codebase.

### Entry points

- [src/index.ts](src/index.ts) — bin entry, builds an `Environment` (cwd, file ctx, console, stdout/stderr, abortCtrl) and calls `runProgram`.
- [src/run-program.ts](src/run-program.ts) → [src/program.ts](src/program.ts) — commander CLI definition. Subcommands: `ls`, `exec`, `up`, `down`, `clean`, `store`, `restore`, `validate`, `package`. Each subcommand builds a `Cli` via `createCli(fileName, environment, workScope)`.
- [src/cli.ts](src/cli.ts) — the programmatic façade (`Cli` class) wrapping a `WorkTree` + `Environment`. Library consumers use `getCli()`; the CLI in `program.ts` is just a thin shell around this.

### Parse: `schema/` and `parser/`

- [src/schema/](src/schema/) — zod schemas for the build file (`build-file-*-schema.ts`) plus the parse pipeline: `schema-parser.ts` → `reference-parser.ts` → `work-scope-parser.ts`. `parse-error.ts` carries zod errors back to the CLI for pretty-printing.
- [src/parser/](src/parser/) — `read-build-file.ts`, `read-env-file.ts`, `default-build-file.ts`, label parsing. JSON schema published at [build.schema.json](build.schema.json) is generated from these zod schemas (see `src/json-schema.ts`).

### Plan: `planner/`

Parsing produces a **WorkTree** ([src/planner/work-tree.ts](src/planner/work-tree.ts)) of `WorkItem`s — `WorkTask` and `WorkService` indexed by id. `work-cache-id.ts` computes the per-task cache hash from sources + command + needs + image; this is what makes incremental builds work. Validation lives in `validate.ts` and `work-item-validation.ts`.

### Runtime selection

Each task/service is bound to a runtime: `local`, `docker`, or `kubernetes` (see `work-runtime-*.ts` in `planner/`, plus [src/runtime/runtime.ts](src/runtime/runtime.ts)). The runtime decides where execution happens.

### Schedule + execute: `executer/`

- [src/executer/execute-work-tree.ts](src/executer/execute-work-tree.ts) is the top-level loop. It builds a `ProcessManager` (worker pool), walks the work tree, and dispatches items.
- `scheduler/` holds the state machines (`task-state.ts`, `service-state.ts`, `dependency-state.ts`, `need-state.ts`) and cycle detection (`check-for-loop.ts`).
- `execute-work-task.ts` / `execute-work-service.ts` are the per-item drivers. They call into `local-task.ts`, `docker-task.ts`, or `docker-service.ts` / `kubernetes-service.ts` depending on runtime.
- `event-cache.ts` implements `clean`/`store`/`restore` — the cache directory hammerkit uses to ship build outputs between machines.
- State propagation is observable via the `State<T>` wrapper ([state.ts](src/executer/state.ts)) and `state-listener.ts`. `watch-loop.ts` powers `--watch` mode.

### Docker + Kubernetes layers

- [src/docker/](src/docker/) — `dockerode`-based helpers: `using-container.ts` (lifecycle), `pull.ts`, `stream.ts`, `package.ts` (image build/push for `hammerkit package`).
- [src/kubernetes/](src/kubernetes/) — `@kubernetes/client-node` helpers for deployments, services, ingress, PVCs, and store/restore of persistent data. Used for `kubernetes-service` items.

### Testing infrastructure

- [src/testing/example-test-suite.ts](src/testing/example-test-suite.ts) — most integration tests copy a fixture from [examples/](examples/) into `temp/<example>/`, build a synthetic `Environment` with in-memory streams, and exercise the CLI through `createCli(...)`. There is one example directory per spec file in `src/testing/integration/`.
- [src/executer/environment-mock.ts](src/executer/environment-mock.ts) is used for unit tests that don't need a real fs.
- `test-streams.ts` provides `emptyStream` / `memoryStream` for capturing console/status output in assertions.

## Conventions

- Prettier: no semicolons, single quotes, 120 cols, 2-space tabs, trailing commas `es5`.
- ESLint: `no-console: error` — never write to `console.*` in `src/` (the `Environment` carries `stdout`/`stderr`/`console`/`status` writables; route output through those).
- TS strict mode is on; `@typescript-eslint/no-explicit-any` is **off**, so `any` is permitted where useful.
- Library consumers import from `src/index.ts` → `dist/index.js`; keep that surface stable.
