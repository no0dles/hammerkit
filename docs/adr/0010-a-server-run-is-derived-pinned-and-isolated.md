# 0010: A server run is derived from a pinned build file, a pinned commit and a process of its own

[ADR-0009](0009-remote-runs-go-through-an-oauth-scheduler-service.md) decides that remote runs go through an OAuth-only server. This records how the server decides what a run may do and where it executes, after the first implementation showed three weak spots: the request named its own account, any git url could be fetched, and every run shared the server's process and environment.

- **The accounts of a run are derived, never requested.** They are the accounts of the secrets of the tasks the run executes, read from the hash-pinned build file by the engine (`planRun`), and derived again by the executor before it starts. A caller's entitlement gives a level per account (`use` runs at once and approves, `request` waits for an approver), so a task without secrets needs no account and a publisher cannot lift an approval by naming tasks differently. One function (`decideRun`) turns grant, accounts, source and version into run, approval or refusal.
- **A ref run names `host/path` and a ref, never a url, and is pinned to a commit.** The caller's `repos` and the operator's `sources` both have to cover the repository. The read credential is a provider secret read as a reserved account that no entitlement and no build file may name, handed to one git process through its environment. The ref is resolved to a commit when the run is submitted and the executor fails if it moved, so what was approved is what runs.
- **Each run executes in a child process with an environment the server builds.** A private home, the allowlisted variables, a cache namespace per source trust and a working directory of its own. A build file may not name the docker host, a cluster, a cache backend, a mount outside the bundle or a runtime the operator did not allow; it is refused at publish.
- **One server is one trust level.** The child process is not a sandbox: it runs as the user of the server. Production and untrusted callers use different servers, each with the accounts of its own level.
- **A caller has limits and runs are kept.** Per-caller quotas for waiting, queued and running runs (`429` over them), a maximum duration, a cap on logs, run records on disk so waiting approvals and finished runs survive a restart, and SIGHUP for the entitlements only.

## Considered options

- **Keep `account` in the run request and check it against the entitlement** — rejected: the request, not the build file, would choose the credential, and approval would depend on what the caller says it needs.
- **Fetch any git url the caller names, with the server's own git configuration** — rejected: the server would fetch from the network for a caller before anybody approved, with ambient credentials.
- **Execute runs inside the server process** — rejected: the engine reads its process environment (docker host, home directory, cloud credentials) and one run could see another's.
- **A container or VM per run as the isolation boundary** — not now: the host backend is the first one, and a stronger boundary belongs with the Kubernetes backend, where a Job per run is natural.

## Consequences

- The config and the API changed from the first implementation: `sources` is a list, entitlements carry levels and `repos`, the run request has no `account`, and a ref run requires `repo`. The server is experimental.
- An operator who needs the docker host or a registry login for runs lists it in `runs.env`; nothing of the server's environment is passed on by default.
- Runs from an `upload` are refused by the executor until the files can be placed with the same checks as a checkout.
