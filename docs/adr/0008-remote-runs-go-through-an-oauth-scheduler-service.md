# 0008: Remote runs go through a scheduler service that only speaks OAuth

Remote compute is a **server** (`hammerkit` run in server mode) that callers reach over HTTPS and authenticate against with **OAuth/OIDC, and nothing else**. A developer's machine, an agent sandbox or a CI job holds a server URL and a short-lived OAuth token: no ssh key, no kubeconfig, no registry login, no secret-manager credential. The server keeps the policy (who may run which tasks, with which service accounts), orchestrates the graph with the existing engine and runs tasks on its own backend: the machine it runs on (docker and local tools), or a Kubernetes cluster (Jobs on node pools chosen by node selector).

Two further rules come with it:

- **The project file never names a destination, only a logical runner name.** The name is resolved through the machine's host config (`servers`), written by `hammerkit remote add`. A build file that could carry a URL could send a developer's source and OAuth login to a server of its choosing.
- **The machine that executes a task holds the secret-manager credentials and resolves its secrets itself.** Callers send references, never values; callers are mapped to the service accounts they may use by an entitlement table on the server, keyed on token issuer and `sub`.

The full design is in [specs/remote-compute](../../specs/remote-compute/spec.md).

## Considered options

- **Client-side transport per runner (ssh, `DOCKER_HOST`, kubeconfig) with the client orchestrating** — rejected: every laptop and agent would need a transport credential, per-user service-account entitlement and a hosted MCP front end would each force a gateway in front of the runner anyway, a closed laptop would stop the run, and `DOCKER_HOST` cannot run tasks with `src` (sources are bind-mounted from the remote filesystem).
- **Client resolves secrets and pushes the values to the runner** — rejected: it makes every orchestrating machine a secret broker and needs a credential on each of them.
- **A generic workflow engine (Argo Workflows, Tekton) running hammerkit inside a job** — rejected as the main path: it loses per-task placement (macOS, mixed platforms), the output handles and per-task cache keys. It remains the fallback for a Kubernetes-only setup.

## Consequences

- A new network service that runs code. It is hardened like a CI server (TLS, token validation with audience, rate limits, audit) and sits behind the existing ingress or VPN.
- The API is a new, versioned compatibility surface.
- Local-first is unchanged: `run.on: local` is the default and a laptop works without a server.
- Cache keys of a remote run are computed where the work runs, so a developer's own OS and CPU cannot leak into them. Without remotes nothing changes.
