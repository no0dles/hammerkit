# 0011: Agents work on server sandboxes, with passthrough arguments and network limits

[ADR-0010](0010-a-server-run-is-derived-pinned-and-isolated.md) runs published tasks on a pinned commit. A coding agent without a machine of its own needs more: a checkout it can read and change between runs, a shell, and a network that reaches a package registry but not the rest of the company. This records how that fits the server without giving up what ADR-0010 decided. The details are in the [remote compute spec](../../specs/remote-compute/spec.md#source-files-and-sandboxes), [task arguments](../../specs/task-arguments/spec.md) and [network limits](../../specs/task-network/spec.md).

- **A sandbox is a caller's checkout that runs published tasks.**
  - Creating one is a fetch with the operator's `sources` credential, not a run. It belongs to the caller and stays until it is deleted, within quotas.
  - Runs on it execute the published, pinned build file with the sandbox as its directory, so an agent's edit to the sandbox's `.hammerkit.yaml` changes nothing until it is proposed and published.
  - An entitlement grants them per repository, with a type per branch pattern: `pull` to start a sandbox from the branch, `push` to also push to it. A source only holds the server's credentials for its host, to read and to push.
  - Accounts opt in with `source: [sandbox]`. Production accounts don't list it. `env:` secrets opt in the same way, through `sandboxes.env.allow`.
  - Its content is written by the caller for the engine too: every path a run derives from it is resolved without following links, and the git dir is never mountable. (Found in review: Docker followed a `src -> /` link into the host's root.)
- **Files have two ways in.** Typed endpoints (tree, read, search, edits, changes) serve clients without tools of their own, and mirror the shapes models are trained on: exact-string replace, `apply_patch` and unified diffs, ripgrep's parameters, numbered reads. A raw read, write and stat surface serves harnesses that keep their own tools and only swap the backend. No vendor standard names these tools, but harnesses converge on the same operations.
- **Arguments are passed through, raw, for every task and service.**
  - What follows `--` is appended to the last command, each argument quoted.
  - A run with arguments skips the cache by default and leaves the task's outputs marked as not cached, so a later plain run never reports them as its own (Pascal, 2026-10-13). Arguments never reach dependencies.
  - A shell is a task whose last command is `sh -c`; there is no exec endpoint.
  - On a server, a run passes no arguments when its task, a dependency or a needed service reads a secret or a credential from the server's environment (Pascal, 2026-10-13). A dependency can write a secret into its outputs and a service can answer with one, and an argument such as `rev token.txt` prints it past the masking. So a shell runs without any account, nor next to one. A server never takes `--set`.
- **Network limits are a field of every container task and service.**
  - The levels are `none` and `open`, plus a host allowlist through an egress proxy per limited item that fails closed. The services in `needs` are reachable at every level, since a task names them because it uses them.
  - A ceiling can be set from outside the build file: `run --network` on a laptop, and `runs.network` and `sandboxes.network` on a server.
  - Local tasks can't be limited and are refused under a ceiling.
  - A limit holds or the run fails, never runs open: Docker 28 or later (internal networks without a route to the host), a proxy per limited item, and on Kubernetes a CNI whose enforcement of `NetworkPolicy` the configuration states (`networkPolicy: enforced`), policies on ingress and egress, removed only after the pods are gone. A limited item on Kubernetes gets no DNS, since cluster DNS forwards any name upstream and queries could carry data out.
- **Sandbox runs use containers only** unless the operator names `local`. The run process is not a boundary (ADR-0010), and a local task could read every other caller's sandbox on the same host.
- **No ambient credentials.** A push uses the source's `secret`, the credential the server reads with, and nothing git finds on the server. On Kubernetes an account without its own credentials is refused rather than run on the node's identity, and each caller's namespace is isolated (its own RoleBinding, default-deny policies, no metadata address, `restricted` Pod Security).

## Considered options

- **A standing container per sandbox** (an always-on dev box) — rejected: it holds CPU and memory while the agent thinks. A directory, or a PVC on Kubernetes, attached on use costs storage only.
- **Run the sandbox's own build file** — rejected: an agent would change what a task does and which account it runs as.
- **A native exec endpoint** — rejected: commands would bypass published build files, their image, network and accounts.
- **Declared, typed arguments with defaults and a schema** — not chosen: passthrough is what `npm` and `make` users know and needs nothing in the build file. The cost is no input schema for MCP tools, which instead describe where the arguments land.
- **Network levels first, host allowlist later** — rejected: without host rules an agent can't install packages without being fully open.
- **A separate `needs` level** (only the needed services) — rejected: needed services are always reachable, so `none` already means that.
- **Arguments in the cache key by default** — rejected: every variant writes the same output paths, so a cache hit could hand back another variant's outputs. An explicit `--cache` opts a run with arguments back in; the record of which run produced a task's outputs is kept per task name, so it names one variant at a time.
- **Covering only the task that gets the arguments** — rejected: a dependency that logs in to a registry writes the credential into what the task reads (an `.npmrc`, a docker `config.json`), and a transform of it slips past the masking. A shell that needs such a dependency runs without arguments, or the dependency's output is published another way.

- **Push branches on the source** — rejected (Pascal, 2026-10-14): who may push where is a caller's permission, so it sits on the entitlement next to `repos` and `accounts`. The source keeps only its `secret`, which is the server's, whoever pushes.
- **A separate push credential on the source (`pushSecret`)** — rejected (Pascal, 2026-10-14): the source's one `secret` reads and pushes; whether a push is allowed is the entitlement's `push` type.

## Consequences

- Arguments and network limits are engine features. They ship first, with their docs, and are useful without a server.
- Run requests gain `source: { type: sandbox }` and `options.args`. Server config gains `sandboxes`, `runs.network`, a `sandboxes` list on entitlements (`repo` and a `pull` or `push` type per branch pattern), and `sandbox` as a value of an account's `source`.
- Building it needs one engine change: a build file whose directory is not where it was read from.
- Kubernetes sandboxes wait for the Kubernetes task executor.
