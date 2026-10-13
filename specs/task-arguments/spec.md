# Feature Specification: Arguments for Tasks and Services

**Created**: 2026-10-12

**Status**: Implemented, locally (FR-001 to FR-006) and on a server (FR-007, FR-008) (ADR-0011)

**Input**: Narrowing a run (one test file, one test name, a flag for a dev server) needs a new task per variation or a `--set` variable the build file has to anticipate. Agents need the same thing on a server: a shell is a task that takes its command as an argument. Pascal decided on raw passthrough, as `npm run x -- ...` and `make` users know it, and that it works locally and remotely.

## User Scenarios & Testing _(mandatory)_

1. **Given** a task whose last command is `npx vitest run`, **When** `hammerkit run test -- src/login.spec.ts -t "login flow"`, **Then** the last command runs as `npx vitest run 'src/login.spec.ts' '-t' 'login flow'` and the earlier commands are unchanged.
2. **Given** `-- 'a; rm -rf /'`, **Then** the task receives one argument with that text; no second command runs.
3. **Given** a task whose last command is `sh -c`, **When** `hammerkit run sh -- 'npm test 2>&1 | tail -20'`, **Then** the shell runs that pipeline.
4. **Given** a service with `cmd: node server.js`, **When** `hammerkit up --filter app=api -- --inspect`, **Then** the service starts as `node server.js --inspect`.
5. **Given** a filter that selects two tasks, **When** arguments are passed, **Then** the command fails before anything runs, naming the selected tasks.
6. **Given** `test` depends on `build`, **When** `hammerkit run test -- -t x`, **Then** `build` runs without arguments and keeps its cache entry.
7. **Given** `test` ran with `-- -t a`, **When** it runs with `-- -t b`, **Then** it is not a cache hit; with `-- -t a` again it is.

## Requirements _(mandatory)_

- **FR-001**: `run` and `up` take arguments after `--`. They are appended to the last command of the one task, or to the `cmd` of the one service, the command line names or selects. A run that selects several items with arguments fails before it starts.
- **FR-002**: Each argument is quoted for the shell the command runs in (the task's `shell`, else `sh`), so shell syntax inside an argument is text. On Windows local tasks the quoting follows that shell.
- **FR-003**: Dependencies and needed services never receive the arguments.
- **FR-004**: The argument list is part of the task's cache key; no arguments and an empty list are the same key as today, so existing cache entries stay valid.
- **FR-005**: The build file declares nothing for arguments. `--set` is unchanged and stays a separate, local mechanism.
- **FR-006**: `hammerkit ls --json` and the published versions of a server show each task's last command (and each service's `cmd`), so a caller can tell where arguments land.
- **FR-007 (server)**: The run request takes `options.args: string[]` with exactly one entry in `tasks`. Limits: 100 arguments, 16 KiB together. A server never takes `--set`.
- **FR-008 (server)**: A run that passes arguments to a task that reads secrets is refused at submit (`400`): an argument can make the command print its secrets. So a shell task never holds an account.

## Implementation notes (server)

- **Where the check sits.** The arguments are applied while the run is planned, so the run's `plan` (what the caller and an approver see) carries the command as it runs. The secrets check reads that plan at submit, and again in the executor before anything starts.
- **What the named task reads.** A version's plan records, per item, the variables of the server its `envs` read (`serverEnvs`), taken from where `$NAME` and `${NAME}` resolved while the build file was read. The task's secrets and any of those other than `PATH`, `HOME` and `CI` refuse arguments. Its dependencies and needed services are not covered (FR-008); the runs docs tell publishers to keep secrets out of what they hand on.
- **Not a service.** A run request names tasks; arguments with a service in `tasks` are `400`.
- **No NUL.** An argument with a NUL character is `400` at the schema, as locally.
- **The approver's view.** `hammerkit remote approvals` and `remote show` list the arguments as JSON strings on a line of their own, so commas and spaces in one stay visible. Arguments and command lines are never cut; other text is cut at 300 characters with a `… (+N chars)` marker. Control characters print as `?`, format characters (bidi, zero-width) as `\u{…}`.

## Out of scope

- Declared, typed arguments with defaults and a schema (considered and not chosen, ADR-0011).
- Arguments for more than one task in a run.
