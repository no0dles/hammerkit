# 0011: Agents work on server sandboxes, with passthrough arguments and network limits

[ADR-0010](0010-a-server-run-is-derived-pinned-and-isolated.md) runs published tasks on a pinned commit. A coding agent without a machine of its own needs more: a checkout it can read and change between runs, a shell, and a network that reaches a package registry but not the rest of the company. This records how that fits the server without giving up what ADR-0010 decided. The details are in the [remote compute spec](../../specs/remote-compute/spec.md#source-files-and-sandboxes), [task arguments](../../specs/task-arguments/spec.md) and [network limits](../../specs/task-network/spec.md).

- **A sandbox is a caller's checkout that runs published tasks.**
  - Creating one is a fetch with the operator's `sources` credential, not a run. It belongs to the caller and stays until it is deleted, within quotas.
  - Runs on it execute the published, pinned build file with the sandbox as its directory, so an agent's edit to the sandbox's `.hammerkit.yaml` changes nothing until it is proposed and published.
  - Accounts opt in with `source: [sandbox]`. Production accounts don't list it.
- **Files have two ways in.** Typed endpoints (tree, read, search, edits, changes) serve clients without tools of their own, and mirror the shapes models are trained on: exact-string replace, `apply_patch` and unified diffs, ripgrep's parameters, numbered reads. A raw read, write and stat surface serves harnesses that keep their own tools and only swap the backend. No vendor standard names these tools, but harnesses converge on the same operations.
- **Arguments are passed through, raw, for every task and service.**
  - What follows `--` is appended to the last command, each argument quoted.
  - The arguments are part of the cache key and never reach dependencies.
  - A shell is a task whose last command is `sh -c`; there is no exec endpoint.
  - On a server, a task that reads secrets takes no arguments, so a shell holds no account. A server never takes `--set`.
- **Network limits are a field of every container task and service.**
  - The levels are `none` and `open`, plus a host allowlist through a per-run egress proxy that fails closed. The services in `needs` are reachable at every level, since a task names them because it uses them.
  - A ceiling can be set from outside the build file: `run --network` on a laptop, and `runs.network` and `sandboxes.network` on a server.
  - Local tasks can't be limited and are refused under a ceiling.
- **Sandbox runs use containers only** unless the operator names `local`. The run process is not a boundary (ADR-0010), and a local task could read every other caller's sandbox on the same host.

## Considered options

- **A standing container per sandbox** (an always-on dev box) — rejected: it holds CPU and memory while the agent thinks. A directory, or a PVC on Kubernetes, attached on use costs storage only.
- **Run the sandbox's own build file** — rejected: an agent would change what a task does and which account it runs as.
- **A native exec endpoint** — rejected: commands would bypass published build files, their image, network and accounts.
- **Declared, typed arguments with defaults and a schema** — not chosen: passthrough is what `npm` and `make` users know and needs nothing in the build file. The cost is no input schema for MCP tools, which instead describe where the arguments land.
- **Network levels first, host allowlist later** — rejected: without host rules an agent can't install packages without being fully open.
- **A separate `needs` level** (only the needed services) — rejected: needed services are always reachable, so `none` already means that.

## Consequences

- Arguments and network limits are engine features. They ship first, with their docs, and are useful without a server.
- Run requests gain `source: { type: sandbox }` and `options.args`. Server config gains `sandboxes`, `runs.network`, `sources[].push`, and `sandbox` as a value of an account's `source`.
- Building it needs one engine change: a build file whose directory is not where it was read from.
- Kubernetes sandboxes wait for the Kubernetes task executor.
