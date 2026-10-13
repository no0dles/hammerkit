# Feature Specification: Network Limits for Tasks and Services

**Created**: 2026-10-12

**Status**: Design, not implemented (ADR-0011)

**Input**: Every container task and service is on the docker default network and reaches whatever the host reaches. An agent's work (and an untrusted install script) should reach the services it needs and a package registry, not the rest of the network. Pascal decided it is a general feature for all tasks and services, with levels and a host allowlist in the first version, and that the services a task needs are always reachable.

## The field

```yaml
tasks:
  test:
    network: none                     # nothing but the services in needs
  e2e:
    needs: [db]
    network: none                     # reaches db, nothing else
  install:
    network: { allow: [registry.npmjs.org, '*.githubusercontent.com'] }   # these hosts, and the services in needs
  deploy:
    network: open                     # what the host reaches; the default, as today
```

The services in `needs` are always reachable, whatever the level: a task names them because it uses them (Pascal, 2026-10-12). The level limits everything else.

| Level | Reaches, besides its `needs` | Docker | Kubernetes |
|---|---|---|---|
| `open` (default) | everything the host reaches | default bridge, as today | no policy |
| `allow: [hosts]` | HTTP(S) to the listed hosts | the item's internal network with its needed services, and a second internal network that only the item and its own egress proxy join; the proxy allows `CONNECT` by host name, and `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` (the needed services) are set for the item | ingress and egress `NetworkPolicy`: out to the item's proxy pod, its services' pods and DNS |
| `none` | nothing | the item's internal network with the needed services attached by name; `NetworkMode: none` when there are none | ingress and egress `NetworkPolicy`: out to its services' pods and DNS only |

The internal networks are created with `com.docker.network.bridge.inhibit_ipv4=true`, so the gateway gives no route to the host: without it a container on an `Internal: true` network still reaches every host port bound to `0.0.0.0` (a host proxy, `dockerd` on :2375, databases). The names carry the run, so concurrent runs never share or remove each other's networks.

## User Scenarios & Testing _(mandatory)_

1. **Given** `network: none` and no `needs`, **When** the task runs `curl https://example.com`, **Then** it fails to resolve or connect.
2. **Given** `network: none` and `needs: [db]`, **Then** the task reaches `db` by its name and nothing else.
3. **Given** `allow: [registry.npmjs.org]`, **Then** `npm ci` succeeds and `curl https://example.com` fails; a tool that ignores the proxy variables finds no route out, and a listener on the host's `0.0.0.0` is not reachable.
4. **Given** a local task with `network: none`, **Then** validation fails: hammerkit can't limit the host's network.
5. **Given** `hammerkit run --network none`, **Then** every task of the run reaches its needed services and nothing else, whatever its own setting, and a local task fails.
6. **Given** a service with `allow: [api.stripe.com]`, **Then** the service reaches that host, and tasks that need the service still reach it.
7. **Given** a task with `allow: [registry.npmjs.org]` that needs a service with `network: none`, **Then** the service can't use the task's proxy and reaches nothing.
8. **Given** a Docker daemon older than 28, **When** a run has a limited item, **Then** it fails before anything starts, naming the version it needs.

## Requirements _(mandatory)_

- **FR-001**: `network` on container tasks and services: `open` (default), `none`, or `{ allow: [hosts] }`. A host is a name or `*.` and a domain; no ports, no IP ranges.
- **FR-002**: The services in `needs` are reachable at every level.
- **FR-003**: The levels are ordered `none` < `allow` < `open`. A ceiling clamps a more open setting down to it, and an `allow` list under an `allow` ceiling is cut to the hosts both lists have.
- **FR-004**: `run --network <level>` and `up --network <level>` set a ceiling for the run, from outside the build file.
- **FR-005**: `network` other than `open` on a local task, or a ceiling below `open` with a local task in the run, is an error before anything runs.
- **FR-006**: The proxy for `allow` is started per limited item, on a network only that item and the proxy join, and accepts connections from the item alone. It is removed with the item and logs each refused host as a run event (`network: refused <host>`), so a failing install says why. It resolves a listed name itself and refuses loopback, link-local (the metadata address), private and the Docker bridge addresses, unless the rule is an exact name. Its image is pinned by digest and runs unprivileged.
- **FR-007**: Not part of the cache key: the setting decides whether a task can work, not what a successful one produces.
- **FR-008**: Ingress from the host is unchanged: ports a limited service publishes stay published, through a relay container that forwards to the service, never by putting the service on a network with a route out. On Kubernetes the policy also limits ingress: a limited pod accepts connections only from the items that need it.
- **FR-009 (server)**: `runs.network` in the server config is the ceiling for every run, and the hosts any `allow` may list. A published version asking for more is refused at publish. `sandboxes.network` is the ceiling for runs on a sandbox (default `none`); it must be within `runs.network` (a config error otherwise), and a sandbox run gets the lower of the two.
- **FR-010**: A limit holds or the run fails; it never runs open. What it depends on:
  - Docker 28 or later, for `inhibit_ipv4`, which also has the fix for CVE-2024-29018 (DNS forwarded from internal networks). A limited item on an older daemon, or on a Windows daemon, is an error before anything starts.
  - On Kubernetes, a CNI that enforces `NetworkPolicy`. Hammerkit can't tell from the API, so the environment (or a server's `backend`) states `networkPolicy: enforced`, and a limited item without it is an error.
  - On Kubernetes, the policy and proxy are named per run and removed only after the item's pods have terminated, so cancel, timeout and failure don't leave pods running without limits. The metadata range (`169.254.0.0/16`) is never allowed.
  - On Kubernetes, a pod's first init container waits until its policy is in force (the cluster's DNS server, which a limited policy doesn't allow, no longer answers on TCP 53), and fails the pod after 60s, since plugins apply a policy a moment after a pod started. As built, the policy allows no DNS at all: needed services and the proxy are host aliases of the pod.

## Out of scope

- Limiting local tasks (it would need OS sandboxing per platform).
- Non-HTTP egress by host (databases, SSH); a database a task uses is a service in its `needs`.
