# Feature Specification: Network Limits for Tasks and Services

**Created**: 2026-10-12

**Status**: Implemented for Docker and Kubernetes environments, and `runs.network` and `sandboxes.network` on a server (ADR-0011).

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
| `allow: [hosts]` | HTTP(S) to the listed hosts | the item's internal network with its needed services, and a second internal network that only the item and its own egress proxy join; the proxy allows `CONNECT` by host name, and `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` (the needed services) are set for the item | ingress and egress `NetworkPolicy`: out to the item's proxy pod and its services' pods, which are host aliases, so no DNS |
| `none` | nothing | the item's internal network with the needed services attached by name; `NetworkMode: none` when there are none | ingress and egress `NetworkPolicy`: out to its services' pods only, no DNS |

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

- **FR-001**: `network` on container tasks and services: `open` (default), `none`, or `{ allow: [hosts] }`. A host is a name or `*.` and a domain, no IP ranges; a name with a port (`db.example.com:5432`) is a TCP forward for clients that don't speak HTTP proxies (Pascal, 2026-10-14).
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
  - On Kubernetes, a CNI that enforces `NetworkPolicy`. Hammerkit can't tell from the API, so the cluster's configuration states it: `networkPolicy: enforced` in the environment's `kubernetes` settings (or a server's `backend`). A limited item without it is an error.
  - On Kubernetes, the policy and proxy are named per run and removed only after the item's pods have terminated, so cancel, timeout and failure don't leave pods running without limits. The metadata range (`169.254.0.0/16`) is never allowed.
  - On Kubernetes, a limited item gets no DNS: cluster DNS forwards any name upstream, so a `none` item could send data out in its queries. The needed services and the proxy are host aliases of the pod instead.

## Implementation notes

- **A network and a proxy per task or service, not per run.** Each item then has its own allow list without the proxy telling its clients apart, and one item's list never opens a host to another. An open item that needs a limited service joins that service's internal network (a link gives the name it needs it by); a limited item has the services it needs join its own, so a limited service never gains a route out through an open neighbour.
- **Docker networks** are named `hammerkit-<instance id>-<run id>`. Under `allow` the item also joins `<name>-proxy`, where its proxy is the only other member. The proxy listens on its address on that network alone, so neither the services on the item's network nor containers on the default bridge reach it. It joins the item's network without listening there, only to reach the needed services. Daemon support is checked once per run with `docker version`.
- **Published ports of a limited service** go through a relay container (`src/network/port-relay.ts`, in the proxy's image) on the default bridge and the service's network, which holds the `PortBindings` and forwards each connection to the service.
- **The proxy image** is the stock `node:24-alpine`, pinned by digest, running a dependency-free script (`node -e`, `src/network/egress-proxy.ts`), so there is no hammerkit image to build, publish and pull. It runs as the image's `node` user without capabilities, on a read-only root and with a memory limit. On Kubernetes it runs as a Deployment and a Service named `hammerkit-proxy-<key>`, with an ingress policy of its own that takes connections from its item's pods only.
- **Kubernetes keys.** A task's policy and proxy are keyed by its id and the run (its job pods carry `hammerkit.dev/run`), so concurrent runs never replace or remove each other's limits. A service has one Deployment whatever the run, so its policy and proxy are keyed by its id. `down` and `clean` remove every policy and proxy of the item once none of its pods runs.
- **Kubernetes ingress.** A limited task takes no connections. A limited service takes them from the pods of the items that need it (`requiredBy`), and from anywhere when an `httpRoute` of the environment points at it, the cluster's equivalent of a published port.
- **Needed services through the proxy.** The proxy allows the names of the needed services too, so a tool that ignores `NO_PROXY` (busybox `wget`) still reaches them. It takes them as exact names, apart from the allow list's patterns, and a limited item whose need name is no host name (`*.com`) is an error when the run starts, under the build file's own network or a `--network` ceiling alike.
- **https URLs.** A client that asks the proxy for an `https://` URL instead of a `CONNECT` (BusyBox `wget`) gets `501` for an allowed host, and the item's log says to use a client that tunnels (`https-url` event); the proxy never terminates TLS. A host not on the list stays refused.
- **TCP forwards.** For each `host:port` entry the proxy also listens on that port, at its own address, and forwards raw TCP to the checked addresses of that host. The item reaches it under the host's name: an `/etc/hosts` entry on Docker (the proxy's address on the proxy network), a host alias on Kubernetes, where the proxy's Service, its ingress policy and the item's egress policy carry the port too. A forward names one host, never a pattern, so the alias is that name; two hosts can't share a port, `3128` is the proxy's, and a forward under a need's name is an error when the run starts. Under a ceiling, a host without a port covers its forwards and a forward covers only itself; a name (forward or not) that one of the two lists allows only through a pattern keeps a pattern's strength (`publicOnly`, no private addresses), and two forwards on one port after the cut are an error. A `CONNECT` to the forward's host and port passes as well. A connection to an unlisted port of a forwarded name is refused by the kernel, with no `refused` event.
- **Every checked address.** The proxy resolves a name itself and connects only to the addresses it checked, trying each in turn, so a name whose first address has no route (IPv6 on a network without it) still works.
- **Healthchecks without the proxy.** A service's healthcheck checks the service itself, so it runs with the proxy variables emptied (the exec's own variables on Docker, `env` in front of the probe on Kubernetes).
- **No DNS on Kubernetes.** The needed services and the proxy are host aliases of the pod, so the policy allows no DNS either: cluster DNS forwards any name upstream, which would let `none` send data out in queries.
- **The gate on Kubernetes.** Some network plugins (kindnet) enforce a policy a moment after a pod started. A limited pod's first init container (`src/kubernetes/network-gate.ts`, in the proxy's image) connects to the pod's nameserver until that fails, which its policy denies, so the item's own containers start only once the policy holds; after a minute it fails the pod instead. It also checks what `networkPolicy: enforced` states.
- **Refused hosts on Kubernetes**: a task follows its proxy's log while its jobs run; a service outlives the run on a cluster, so its refused hosts stay in its proxy's log.
- **Cleanup.** A daemon service keeps its network and proxy until `down`; `clean` removes the networks and proxies of a killed run, like its containers.
- **`runs.network` is checked three times.** At publish and propose, every task and service of the version against it (the error names the item, what it asks for and the ceiling). At submit and in the executor, the run's items again, so a version published before the operator set a ceiling, and asking for more, is refused rather than clamped silently. The executor also hands the ceiling to the run's process as `--network`, so the engine enforces it.
- **`runs.network` and local tasks.** A ceiling below `open` with `local` in `runtimes` is a config error: no local task could be published.
- **Published versions show the network.** Each item of a version's `plan` carries its `network` as the build file declares it, next to `command`, its last command.
- **A ceiling and running services.** The effective network is part of a service's definition hash, so a service started by an earlier `up` is recreated when a ceiling changes its network.

## Out of scope

- Limiting local tasks (it would need OS sandboxing per platform).
- Non-HTTP egress by host (databases, SSH); a database a task uses is a service in its `needs`.
