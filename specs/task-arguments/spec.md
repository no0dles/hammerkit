# Feature Specification: Arguments for Tasks and Services

**Created**: 2026-10-12

**Status**: Local side implemented (FR-001 to FR-006); the server side (FR-007, FR-008) is not built yet (ADR-0011)

**Input**: Narrowing a run (one test file, one test name, a flag for a dev server) needs a new task per variation or a `--set` variable the build file has to anticipate. Agents need the same thing on a server: a shell is a task that takes its command as an argument. Pascal decided on raw passthrough, as `npm run x -- ...` and `make` users know it, and that it works locally and remotely.

## User Scenarios & Testing _(mandatory)_

1. **Given** a task whose last command is `npx vitest run`, **When** `hammerkit run test -- src/login.spec.ts -t "login flow"`, **Then** the last command runs as `npx vitest run 'src/login.spec.ts' '-t' 'login flow'` and the earlier commands are unchanged.
2. **Given** `-- 'a; rm -rf /'`, **Then** the task receives one argument with that text; no second command runs.
3. **Given** a task whose last command is `sh -c`, **When** `hammerkit run sh -- 'npm test 2>&1 | tail -20'`, **Then** the shell runs that pipeline.
4. **Given** a service with `cmd: node server.js`, **When** `hammerkit up --filter app=api -- --inspect`, **Then** the service starts as `node server.js --inspect`.
5. **Given** a filter that selects two tasks, **When** arguments are passed, **Then** the command fails before anything runs, naming the selected tasks.
6. **Given** `test` depends on `build`, **When** `hammerkit run test -- -t x`, **Then** `build` runs without arguments and keeps its cache entry.
7. **Given** `build` ran without arguments and wrote `dist`, **When** `hammerkit run build -- --prod` runs, **Then** it reads and writes no cache entry, and the next `hammerkit run build` is not a cache hit: it runs again (or restores from the cache) instead of reporting the production `dist` as its own.
8. **Given** a task on Kubernetes, **When** it runs with `-- 'costs $(HOME) $$'`, **Then** the command receives that text unchanged.

## Requirements _(mandatory)_

- **FR-001**: `run` and `up` take arguments after `--`. They are appended to the last command of the one task, or to the `cmd` of the one service, the command line names or selects. A run that selects several items with arguments fails before it starts.
- **FR-002**: Each argument is quoted for the shell the command runs in (the task's `shell`, else `sh`), so shell syntax inside an argument is text. A shell hammerkit can't quote for (fish, cmd, csh) is an error. Two places parse the line again and are handled:
  - On Kubernetes the kubelet expands `$(NAME)` and `$$` in a container's command before the shell runs, so `$` in an argument is written as `$$`.
  - On Windows local tasks the quoting follows PowerShell, but Windows PowerShell 5.1 builds a new command line for a native program and starts `.cmd`/`.bat` shims through `cmd.exe`. There an empty argument, an argument with `"`, one with `&|<>^%!` or a line break, or one with a space that ends in `\` is refused rather than split or run.
- **FR-003**: Dependencies and needed services never receive the arguments.
- **FR-004**: A run with arguments skips the cache by default (Pascal, 2026-10-13): the task reads no cache entry and writes none. Its outputs land where the task's outputs always do, so before it writes them it removes the task's record of a cached run, and the next run without arguments is a miss. Without arguments (or with an empty list) the cache works as today, and existing entries stay valid. The arguments are part of the task's id, so logs and run results tell the variants apart.
  - The record of which run produced a task's outputs is kept per task name and holds the id of that run, so it names one variant at a time, and restoring outputs from a cache removes it.
  - An explicit `--cache <method>` on the command line keeps the cache for a run with arguments; that variant then hits only its own entry.
  - A service's definition takes its `init` task by the id without arguments, so running the init with arguments doesn't recreate the service.
- **FR-005**: The build file declares nothing for arguments. `--set` is unchanged and stays a separate, local mechanism.
- **FR-006**: `hammerkit ls --json` and the published versions of a server show each task's last command (and each service's `cmd`), so a caller can tell where arguments land.
- **FR-007 (server)**: The run request takes `options.args: string[]` with exactly one entry in `tasks`. Limits: 100 arguments, 16 KiB together, no NUL. A server never takes `--set`. An approver sees every argument in full: nothing is cut without a marker, and control and bidi characters are escaped.
- **FR-008 (server)**: A run that passes arguments to a task is refused at submit (`400`), and again before it starts, when that task reads a secret or takes a value of an `envs` entry from the server's environment (`runs.env`), other than `PATH`, `HOME` and `CI`. An argument can make the command print what it holds, so a shell task holds no account and no server credential.
  - Not covered, and documented for publishers: a dependency of the task and a service it needs may still read secrets. The task with arguments reads their outputs and calls the service, so a dependency of a shell must not write a secret into its outputs, and a service holding a secret must not serve it.

## Out of scope

- Declared, typed arguments with defaults and a schema (considered and not chosen, ADR-0011).
- Arguments for more than one task in a run.
