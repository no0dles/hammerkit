# Feature Specification: Remote Compute

**Status**: Draft, implementation in progress (ADR-0009, ADR-0010; sandboxes designed in ADR-0011). Delivered in phases; later phases are marked.

**Input**: run tasks on machines the team operates, so a laptop or a coding agent keeps working locally while heavy or platform-specific work runs elsewhere, with outputs staying on the remote until someone asks for them, and with authorization decided by OAuth alone.

## Goals

1. Tasks run on **servers** that an operator sets up. Agents and developers need no virtualisation and no credentials other than an OAuth login.
2. A task states **what it needs** (platform, CPU, memory) and which **runner** it belongs on; the server places it. Local (non-container) tasks are supported for tooling that cannot run in a container (Xcode, a Windows SDK).
3. **Outputs stay remote.** `node_modules` is not copied back. An agent or person reads, searches or fetches selected parts on demand, by CLI or MCP.
4. **Who may use which service account is decided by the server** from the caller's OAuth identity, not by anything in the project.
5. The build file works unchanged locally and remotely.

## Architecture

```
callers: CLI, agents, MCP / Open WebUI, CI           OAuth only
        |  HTTPS: submit run, stream events, read outputs
        v
hammerkit server
  - OAuth resource server (iss, aud, exp checked; several issuers)
  - policy: entitlements (caller -> level on service accounts, builds, repos); the accounts of a run are derived from the secrets of the published build file
  - scheduler: plans and orchestrates the graph with the existing engine, places tasks
  - run registry: runs, state, logs, handles; streams events
        |
        v
backend: this machine (docker, local tools)  |  Kubernetes (Jobs on node pools)  |  later: more
  - holds the provider credentials, resolves secrets, executes, pushes outputs to the cache, serves reads
```

### Deployment modes

| Mode | The server runs on | Tasks run | Scale |
|---|---|---|---|
| **Host** | A machine (Linux, a Mac, Windows) | On that machine via the docker and local runtimes | One machine; runs queue when it is full |
| **Kubernetes** | A cluster | As Jobs, one namespace per user, placed on node pools by node selector (`kubernetes.io/os`, `kubernetes.io/arch`, labels); Kubernetes queues what does not fit | The cluster |

A run executes on **one server**. A graph needing a platform the server does not offer (a Mac task against a Linux cluster) fails at plan time naming the constraint; the Mac is its own server and a second invocation. Routing a run across several servers is a later step; every server publishes its capabilities (platforms, pools, resources) from the start so it can be built on.

### Identities

| Caller | Credential | Entitlement entry |
|---|---|---|
| Developer | Interactive OAuth login (browser or device code); short-lived token | `sub` of the person, or a group |
| Agent | Its own OAuth client-credentials identity | the client's `sub`, with only the accounts that agent needs |
| CI | The job's own OIDC token from the CI platform, exchanged at the server; nothing stored in CI | issuer + claims (repository, branch, environment) |

The server accepts several issuers (the company IdP and each CI platform).

### Policy (server config, reviewed like code)

```yaml
secretProviders:                  # commands, the operator's, never a build file's
  gsm: { command: [gcloud, secrets, versions, access, latest, '--secret={{ref}}'] }
accounts:                         # the catalog; a secret names one of these
  op-payments-dev:
    providers: { gsm: { env: { CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: /etc/hammerkit/dev.json } } }
    source: [ref, upload, sandbox] # sandbox runs only for accounts that list it
  op-payments-prod:
    providers: { gsm: { env: { CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: /etc/hammerkit/prod.json } } }
    source: [ref]                 # production accounts only for reviewed code
    refs: [main, 'release/*']
sources:                          # where code may come from, host/path patterns, most specific first
  - match: github.com/corp/*
    secret: { from: 'gsm:github-readonly-token', account: scm-read }   # a reserved account, no caller uses it
    push: { secret: { from: 'gsm:github-agent-push', account: scm-push }, branches: ['agent/**'] }   # designed: sandbox push; `secret` is required
runtimes: [docker]                # what tasks may run on; `local` has to be allowed by name
approvals: { timeout: 1h, maxWaiting: 100, cooldown: 10m }
runs:
  env: { allow: [PATH, DOCKER_HOST] }   # the only variables of the server a run sees
  limits: { waiting: 10, queued: 20, running: 2 }   # per caller, 429 over it
  maxDuration: 1h
  network: open                   # designed: the most open network a task gets (a task's form)
sandboxes:                        # designed, ADR-0011
  runtimes: [docker]              # default: `runtimes` without `local`
  network: { allow: [registry.npmjs.org] }   # default none; within runs.network
  limits: { count: 5, bytes: 20Gi }
  total: 500Gi
entitlements:
  - subject: { iss: https://idp.corp, sub: 4f1c... }
    accounts: { op-payments-dev: use, op-payments-prod: request }
    repos: [github.com/corp/*]    # the repositories a ref run may name
    sandboxes: true               # designed: may keep sandboxes of these repos
    builds: run                   # run | propose | publish, each includes the lower
  - group: { iss: https://idp.corp, name: release-managers }
    accounts: { op-payments-prod: use }
  - claims: { iss: https://token.actions.githubusercontent.com, match: { repository: corp/payments, ref: refs/heads/main } }
    accounts: { op-payments-dev: use }
    repos: [github.com/corp/payments]
    builds: publish
backend:
  type: host                      # host | kubernetes
  platform: { os: linux, arch: amd64 }
```

- Matching uses issuer and `sub` from the validated token only. Default deny: no entry, no account.
- `source: upload` is the caller's working tree; `source: ref` is a git ref the server checks out itself.
- A published build file may name accounts but must not define providers or accounts; they come from the server config.
- No account is named in a run request, on a task or by a default: the accounts of a run are the accounts of the secrets of the tasks it executes, derived by the engine from the hash-pinned files and the run's scope. A task without secrets holds no credentials and needs no account. On a server a provider secret must name its `account`, `file:` secrets are refused and `env:` secrets only read variables of `runs.env.allow`.
- Every grant decision is logged with issuer, `sub`, matched entitlements and accounts.
- A run from `source: ref` names a repository (`host/path`) and a ref in the request, never a url. The caller's `repos` and the operator's `sources` both have to cover it. The ref is pinned to a commit when the run is submitted and the executor fails if the ref moved, so what was approved is what runs. The read credential is a secret of a provider read as a reserved account, handed to git for one fetch through its environment, and masked in logs.
- A run executes in a process of its own with a private home directory, a cache namespace per source trust, the allowlisted environment, and no other secret than those of its accounts. A published build file may not name an environment, a Kubernetes service, a cache backend, a mount or a `src` outside the bundle or a runtime the operator did not allow, and a `file:` secret is refused: where things run and what is read from the machine is the operator's.
- **On a Kubernetes backend** (designed, the task executor):
  - Each caller's namespace is its own tenant. The server holds a `RoleBinding` per caller namespace, never a cluster-wide binding. Each caller namespace gets a default-deny ingress and egress `NetworkPolicy` that allows DNS and the server explicitly and never the metadata range (`169.254.0.0/16`), and the `restricted` Pod Security level.
  - An account is resolved in the Job with credentials minted for that account (workload identity, or a token minted per Job just before it starts, so a long first command or a pending pod doesn't outlive it). An account without `kubernetes` credentials is refused on a Kubernetes backend; nothing falls back to the node's or the server's own identity.
- Per caller (issuer and subject) the server limits the runs that wait for an approval, that wait in the queue and that execute at once (`429` over the first two); a run is stopped after `runs.maxDuration` and its log is capped. Runs are written to the storage directory when their state changes: a restart keeps finished runs, lets waiting runs wait on, and fails the ones that were queued or running with the server. SIGHUP reloads the entitlements only; the rest of the config needs a restart.

### Secrets

The machine that executes a task holds the secret-manager credentials and resolves secrets itself with the same code path a local run uses. Callers send references only. Values live in memory or a 0700 tmpfs for the task's duration and are removed on every exit path; logs are redacted before they leave the executing side. Because the server plans remote runs with the credentials in place, ids of tasks with `cache: true` secrets are known without anything crossing the wire but a salted digest.

## Published build files

The server holds the build file; a run names a published build file and the tasks to execute, it does not bring task definitions. So an agent that may run work cannot change what a task does, and what needs a second person's approval is decided by the access mode of the account, which the operator sets (see Approvals).

- A **bundle** is the entry file and every file it includes, as text (200 files, 1 MiB), published with `PUT /v1/definitions/<name>`. `builds: run | propose | publish` on an entitlement is a separate permission from `accounts`, so who defines work and who runs it differ by configuration (CI on main publishes, agents run). Build file names are free, the config never lists them. A bundle whose secrets name an account the publisher does not `use` is a proposal even for `publish`, approved by a publisher who uses those accounts.
- The **version** is the sha-256 of the bundle (entry and every path with the hash of its content, paths sorted), computed identically by server and client. Versions are immutable and kept on disk; publishing the same files again changes nothing; `latest` is the one published last. A run pins the hash it was started with.
- A bundle is read on publish in a directory of its own, so a build file that does not load, includes something outside of the bundle or an unpinned or local git include is refused then. The hash can only vouch for what is inside the bundle.
- Local, unpublished build files are not run on a server: a developer who wants to try a change publishes it (with a publish permission for a name of their own).
- Limit: pinning the commands does not pin the code they run. `npm test` still executes the files a run brings, so production accounts stay on `source: ref` and behind `request`, and new versions of a build file get approved (see Approvals).

## Source files and sandboxes

**Upload (built).** A run from `source: upload` names a **snapshot**: the hash of a manifest of paths, content digests and modes. The client announces the manifest (`POST /v1/sources`), the server answers which digests it lacks, the client sends those (`PUT /v1/sources/blobs/<sha256>`), and a run is accepted only for a complete snapshot. So a second run after one edited file moves that file only, and an unchanged tree moves nothing.

- Which files: the published version lists, per task, the `src` patterns, mounts, `deps` and `needs` (`inputs`), relative to the bundle root, so a client computes the set from the tasks it asks for without planning the build file itself (the laptop does not plan under v2).
- Content is kept per caller and never shared between callers: a shared store would answer "I have this file" to anybody and show what others work on.
- Files that look like credentials (`.env`, `.npmrc`, keys, `.git/`, `.ssh/`, `.aws/`) are refused even when a `src` pattern reaches them. Secrets go through secret providers; there is no override.
- Limits are part of the API from the start: 20,000 files, 32 MiB per file, 1 GiB per tree, 4 GiB per caller, nothing evicted on its own.
- Not built: the client that walks the tree and sends the delta, `ref` plus a delta for tracked files, and the matcher with `!` exclusions on the Kubernetes upload path (a `// TODO` in `src/kubernetes/volumes.ts`).

**Sandbox (designed, not built; ADR-0011).** A sandbox is a caller's own checkout on the server, which runs published tasks. It is for an agent with no machine and for a person whose laptop should not build, not for production.

- **Create** (`POST /v1/sandboxes { repo, ref }`) resolves the ref to a commit and fetches it with the read credential of the operator's `sources`, like a ref run. It is a fetch, not a run: no container and no slot of the run limits. An entitlement with `sandboxes: true` may create sandboxes of its `repos`. A sandbox belongs to its caller (`404` for anybody else), stays until it is deleted (no TTL, nothing evicted), and counts against `sandboxes.limits` (count and bytes per caller, a total).
- **Files.** Two ways in. The first is typed endpoints for clients without tools of their own (MCP): `tree`, `files` (`offset`/`limit`, numbered lines), `search` (ripgrep's parameters), `edits` (atomic batches of `replace` with `old_string`/`new_string`, `write`, `delete`, `move`, and `patch` as a git diff or an `apply_patch` body), and `changes` (summary, diff or patch against the base commit). The second is a raw surface for harnesses that bring their own tools and only swap the backend (pi's tool operations): read and write bytes, and stat. Every list, read and search is capped, with a total and a cursor. No symbolic link is followed, `.git/` and the upload deny list are never read or written, and edits while a run holds the sandbox are `409`.
- **Runs** name `source: { type: sandbox, id }`. The published, pinned build file runs: its files are read from the run's private directory with the sandbox as their directory, so the sandbox's own `.hammerkit.yaml` is just a file. Rules for these runs:
  - One run per sandbox at a time.
  - Container runtimes only, unless the operator lists `local` in `sandboxes.runtimes`. Its default is `runtimes` without `local`, and it is checked only when an entitlement grants sandboxes, so a server with `runtimes: [local]` and no sandboxes starts as before.
  - The sandbox's content is written by the caller, for the engine as much as for the file API. Every path a run derives from it (`src`, `mounts`, `generates`, exported outputs, Kubernetes `subPath`s) is resolved without following a symbolic link in any component, and the run fails if one is found; alternatively only the sandbox root is bound and links resolve inside the container. The git dir is never inside anything a task can mount (on Kubernetes it is a volume of its own), and git runs on a sandbox with `core.hooksPath=/dev/null`.
  - An `env:` secret is read by a sandbox run only when `sandboxes.env.allow` lists its variable (empty by default), as accounts need `source: sandbox`.
  - The cache namespace is per owner.
  - The run records the base commit and a hash of the diff it started from.
- **Accounts** are used by sandbox runs only when their `source` lists `sandbox`; an account without `source` takes `ref` and `upload`, not `sandbox`.
- **Shell.** A shell is a published task whose last command is `sh -c`, run with [arguments](../task-arguments/spec.md) (`options.args`). A task that reads a secret or a credential from the server's environment takes no arguments on a server, so a shell holds no account. Its dependencies and needed services are not covered, so they must not hand a secret on (FR-008 there). Its network is capped by the lower of `runs.network` and `sandboxes.network` ([network limits](../task-network/spec.md)).
- **Work out**: first, a patch from `changes` that the caller turns into a branch. Later, `POST /v1/sandboxes/<id>/push { branch, message }` with the write credential of `sources[].push`, only to the branches it lists (`agent/**`). `push.secret` is required, and git runs without the server's own git config, credential helpers or SSH agent, so a push never uses a credential the server happens to have. On Kubernetes the server resolves the credential and never trusts what a pod in the caller's namespace reports about the commit. Pushed branches run the repository's CI on unreviewed code, so operators keep the push patterns out of CI that holds secrets. **Work in**: the `patch` edit, so a laptop's uncommitted work needs no second upload path.
- **Storage** is one interface (create, attach to a run, files, usage, delete) with two implementations. On a host it is a directory. On Kubernetes it is a PVC in the caller's namespace, mounted only while a task or a short file-operation pod runs, so an idle sandbox costs storage only, and a `ResourceQuota` on storage is the quota. Kubernetes needs the task executor first.

## Approvals

- A service account is given to a caller at one of two levels in the entitlements: `use` runs on it at once and approves the runs others request on it, `request` lets them ask for runs on it, which wait until somebody who may `use` it approves. `use` wins where both are given. The same shape serves a person who is not trusted with a key yet and an agent that proposes a deployment for a person to confirm.
- The accounts of a run are derived from the secrets in the pinned build file, so nothing in a request or in how a task is named or labelled changes them. (Found in review: earlier rules on task names and labels could be dodged by whoever may publish, and were removed; a task can not read a secret without its account.) The executor derives them again before it starts and the secret resolver refuses any other account.
- A requested run waits in `awaiting-approval`: an approver covers every account they `use`, never the one who asked, and the run is released when the approvals cover all waiting accounts (one person using all, or one per account). The accounts have one run-level expiry; a rejection by any covering approver, or the timeout, ends it as `rejected`. A request for an account nobody uses is refused at once. Waiting runs are limited. `GET /v1/approvals`, `POST /v1/approvals/<id>/approve|reject`; the decision is an event of the run. A caller only sees and decides what they use.
- Approvers read the published build files, so they can read what they approve. A run that waits shows its `plan`: per task the commands, image, secrets, mounts and accounts as the engine reads them (`remote show <run>`).
- Build file changes get the same treatment: `builds: propose` is the lower level of `publish`. A bundle from a caller who may only propose, or who lacks `use` on an account it names, is read like a publish and kept as a **proposal** (in memory, expiring with the same timeout and limit), not as a version: it can not run and is not `latest`. A publisher who uses the missing accounts, not the proposer, approves it, and only then it is published (proposer as `publishedBy`, approver as `approvedBy`). `GET /v1/proposals`, `/v1/proposals/<name>/<hash>[/files]`, `POST .../approve|reject`. A caller sees the proposals they made, and publishers see all. A proposal records the version it follows and is approved only while that is still the latest (else it is `stale` and can only be rejected), it may not include from git (the server would fetch before anybody approved), and a rejection starts a cooldown for the proposer and the version.
- A published version can be **yanked** by whoever publishes the build file or uses an account of the version, with a reason: it is no longer `latest`, runs of it are refused at submit and again before they start, and `unyank` (publishers) lets it go on.
- What an approved version does not cover: the code its commands run (see the limit above).
- This is meant to be the mechanism the secrets design reuses for the step-up approval of `reveal`: an approval is a decision by a different identity on one pinned request.

## Placement and the runner

- `platform: { os, arch }` and `resources` on a task select the pool or machine; unconstrained tasks use the backend's default.
- `runner: <name>` on a task (or as a build-file default) says where it must run. The name is resolved through the host config; unknown name is an error, never a local run.
- Precedence of the location, highest first: `--on <name>` / `--local`, `HAMMERKIT_ON`, the task's `runner:`, `run.on` in the host config, `local`.
- No silent fallback to local when a server is unknown or unreachable.
- One invocation resolves to one server. A dependency naming a different runner is a plan-time error.
- Kubernetes mode: a local task runs in the pool's `toolImage`; macOS is not a Kubernetes node platform.
- Cache identity uses the platform the task runs on.

## Host config and the `remote` commands

`~/.hammerkit/config.yaml` (overridable with `HAMMERKIT_CONFIG`) is host-level and never part of a project:

```yaml
servers:
  mac-mini: { url: https://mac-mini.corp, issuer: https://idp.corp }
run:
  on: local          # local | auto | <server name>
```

```bash
hammerkit remote add <name> <url> --issuer <url>   # register; https only (http for localhost)
hammerkit remote list
hammerkit remote use <local|auto|name>             # default location
hammerkit remote remove <name>
hammerkit remote login <name>                      # phase B1, OAuth sign-in
hammerkit remote accounts [name]                   # phase B1, service accounts assigned to me
hammerkit remote publish <definition> [server]     # phase B1, publish the build file as a bundle
hammerkit remote approvals [server]                # phase B1, runs waiting for my approval
hammerkit remote approve|reject <run> [server]
```

Registering a name again with another URL or issuer needs `--force`. `remote add` stores no credential. `remote login` checks the registered issuer against the server's discovery document, so `--issuer` is an assertion the server has to confirm before any identity provider is contacted. Login is the OAuth device grant with the client the server publishes; one short-lived access token is stored per server in `credentials.json` (mode 0600), bound to the URL and issuer, and no refresh token is kept (an OS keychain with refresh is a later option). The client, audience and scope a login asks for are pinned in the host config at the first login (or by `remote add`), a server that later offers others is refused, and the token is checked for issuer and audience before it is sent to the server, so a hostile server can't turn `remote login` into a device-code phish for another service.

## Outputs and reading them (phase B1)

A finished remote task yields a handle (`hk://<server>/<task>@<state key>`) in `run --summary-json`. Bytes stay on the backend. Reading is by command, with output limits so an LLM context is never flooded:

`hammerkit output ls | read | grep | glob | fetch | logs <handle>`

- `grep` and `glob` run on the backend (ripgrep) and return matches only.
- `fetch <handle> <glob> --to <dir>` is the only command that copies files locally, and only the selected ones.
- Reads are limited to declared outputs, `src` and logs of the handle, with path traversal rejected, and are checked against the caller.
- The same operations are exposed as MCP tools by `hammerkit mcp` (stdio first, streamable HTTP later).

## Security properties

- The only credential on a caller's machine is a short-lived OAuth token, audience-bound to the server.
- A project file cannot cause a server to be trusted or a destination to be chosen.
- A compromised caller gets only that identity's entitlement; a compromised policy layer can grant only accounts the backend is configured to honour.
- Backends hold least-privilege, short-lived provider credentials; one backend serves one trust level (agents on one, release on another).
- Build code is trusted; third-party code inside tasks (install scripts) is why secrets go only to tasks that need them, which the plan of a version (the accounts per task) makes visible to the people who approve it.

## Phases

| Phase | Content |
|---|---|
| A | Secret providers and per-task service accounts, local only (separate spec). |
| B0 | This foundation: ADR-0009, this spec, the host config and `remote add / list / use / remove`. |
| C | MCP/Open WebUI front end, detached-run polish, high-availability store, routing across several servers, more backends. |

## Open questions

- The command that hosts the server is `hammerkit server` (a top-level `hammerkit serve` would shadow a documented task example). Open for Pascal to rename before the release.
- The discovery document format served by a server for `remote add`.
- Which CI platforms are supported first (GitHub Actions OIDC, then GitLab).
