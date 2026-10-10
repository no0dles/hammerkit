# Feature Specification: Remote Compute

**Status**: Draft, implementation in progress (ADR-0008). Delivered in phases; later phases are marked.

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
  - policy: entitlements (caller -> service accounts) and rules (caller -> tasks, source)
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
entitlements:
  - subject: { iss: https://idp.corp, sub: 4f1c... }
    accounts: [op-payments-dev]
    default: op-payments-dev
  - group: eng-web
    accounts: [op-web-dev]
  - subject: { iss: https://token.actions.githubusercontent.com, sub: "repo:corp/payments:ref:refs/heads/main" }
    accounts: [op-payments-ci]
    source: [ref]
rules:
  - match: { group: release }
    tasks: all
    accounts: [op-prod-deploy]
    source: [ref]                 # production accounts only for reviewed code
backend:
  type: host                      # host | kubernetes
  platform: { os: linux, arch: amd64 }
```

- Matching uses issuer and `sub` from the validated token only. Default deny: no entry, no account.
- `source: upload` is the caller's working tree; `source: ref` is a git ref the server checks out itself.
- An uploaded working tree may name providers and accounts but must not define them; definitions come from the server config or an allowed SHA-pinned include.
- Every grant decision is logged with issuer, `sub`, matched rule and accounts.

### Secrets

The machine that executes a task holds the secret-manager credentials and resolves secrets itself with the same code path a local run uses. Callers send references only. Values live in memory or a 0700 tmpfs for the task's duration and are removed on every exit path; logs are redacted before they leave the executing side. Because the server plans remote runs with the credentials in place, ids of tasks with `cache: true` secrets are known without anything crossing the wire but a salted digest.

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
```

Registering a name again with another URL or issuer needs `--force`. `remote add` stores no credential. Discovery of the issuer from the server, and a confirmation of it, arrive with the server (`--issuer` then becomes an assertion).

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
- Build code is trusted; third-party code inside tasks (install scripts) is why secrets go only to tasks that need them, which rules can enforce.

## Phases

| Phase | Content |
|---|---|
| A | Secret providers and per-task service accounts, local only (separate spec). |
| B0 | This foundation: ADR-0008, this spec, the host config and `remote add / list / use / remove`. |
| B1 | The `runner:` field and placement rules (done); `hammerkit server` with config and discovery (done); OAuth token validation, entitlements and `GET /v1/me` (done); then `remote login` and `remote accounts`, run registry, event streaming, snapshot upload and ref checkout, `run --on`, handles and `output`. The discovery document makes `remote add --issuer` an assertion. |
| B2 | Kubernetes backend: Jobs on node pools, namespace per user, in-cluster secret path, log streaming, upload dedupe, backend-side cache push. |
| C | MCP/Open WebUI front end, detached-run polish, high-availability store, routing across several servers, more backends. |

## Open questions

- The command that hosts the server is `hammerkit server` (a top-level `hammerkit serve` would shadow a documented task example). Open for Pascal to rename before the release.
- The discovery document format served by a server for `remote add`.
- Which CI platforms are supported first (GitHub Actions OIDC, then GitLab).
