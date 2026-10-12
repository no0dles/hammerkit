# Feature Specification: Network Limits for Tasks and Services

**Created**: 2026-10-12

**Status**: Implemented for Docker and Kubernetes environments (ADR-0011). FR-009, the server's ceilings, is not (agent harness work item 4).

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
| `allow: [hosts]` | HTTP(S) to the listed hosts | an internal network of the task or service, with the needed services and its own egress proxy container that allows `CONNECT` by host name; `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` (the needed services) set for it | `NetworkPolicy` to its proxy pod and the services' pods |
| `none` | nothing | an internal network of the task or service (`Internal: true`) with the needed services attached by name; `NetworkMode: none` for a task that needs none | `NetworkPolicy` to the services' pods only |

## User Scenarios & Testing _(mandatory)_

1. **Given** `network: none` and no `needs`, **When** the task runs `curl https://example.com`, **Then** it fails to resolve or connect.
2. **Given** `network: none` and `needs: [db]`, **Then** the task reaches `db` by its name and nothing else.
3. **Given** `allow: [registry.npmjs.org]`, **Then** `npm ci` succeeds and `curl https://example.com` fails; a tool that ignores the proxy variables finds no route out.
4. **Given** a local task with `network: none`, **Then** validation fails: hammerkit can't limit the host's network.
5. **Given** `hammerkit run --network none`, **Then** every task of the run reaches its needed services and nothing else, whatever its own setting, and a local task fails.
6. **Given** a service with `allow: [api.stripe.com]`, **Then** the service reaches that host, and tasks that need the service still reach it.

## Requirements _(mandatory)_

- **FR-001**: `network` on container tasks and services: `open` (default), `none`, or `{ allow: [hosts] }`. A host is a name or `*.` and a domain; no ports, no IP ranges.
- **FR-002**: The services in `needs` are reachable at every level.
- **FR-003**: The levels are ordered `none` < `allow` < `open`. A ceiling clamps a more open setting down to it, and an `allow` list under an `allow` ceiling is cut to the hosts both lists have.
- **FR-004**: `run --network <level>` and `up --network <level>` set a ceiling for the run, from outside the build file.
- **FR-005**: `network` other than `open` on a local task, or a ceiling below `open` with a local task in the run, is an error before anything runs.
- **FR-006**: The proxy for `allow` is started for each limited task or service on its internal network, removed with it, and logs each refused host as an event of the task or service (`network: refused <host>`), so a failing install says why.
- **FR-007**: Not part of the cache key: the setting decides whether a task can work, not what a successful one produces.
- **FR-008**: Ingress is unchanged: ports published to the host stay published.
- **FR-009 (server)**: `runs.network` in the server config is the ceiling for every run, and the hosts any `allow` may list. A published version asking for more is refused at publish. `sandboxes.network` is the ceiling for runs on a sandbox (default `none`).

## Implementation notes

- **A network and a proxy per task or service, not per run.** Each item then has its own allow list without the proxy telling its clients apart, and one item's list never opens a host to another. An open item that needs a limited service joins that service's internal network (a link gives the name it needs it by); a limited item has the services it needs join its own, so a limited service never gains a route out through an open neighbour.
- **The proxy image** is the stock `node:24-alpine` running a dependency-free script (`node -e`, `src/network/egress-proxy.ts`), so there is no hammerkit image to build, publish and pull. On Kubernetes it runs as a Deployment and a Service named `hammerkit-proxy-<id>`.
- **Needed services through the proxy.** The proxy allows the names of the needed services too, so a tool that ignores `NO_PROXY` (busybox `wget`) still reaches them.
- **Healthchecks without the proxy.** A service's healthcheck checks the service itself, so it runs with the proxy variables emptied (the exec's own variables on Docker, `env` in front of the probe on Kubernetes).
- **No DNS on Kubernetes.** The needed services and the proxy are host aliases of the pod, so the policy allows no DNS either.
- **Refused hosts on Kubernetes**: a task follows its proxy's log while its jobs run; a service outlives the run on a cluster, so its refused hosts stay in its proxy's log.
- **Cleanup.** A daemon service keeps its network and proxy until `down`; `clean` removes the networks and proxies of a killed run, like its containers.
- **A ceiling and running services.** The effective network is part of a service's definition hash, so a service started by an earlier `up` is recreated when a ceiling changes its network.

## Out of scope

- Limiting local tasks (it would need OS sandboxing per platform).
- Non-HTTP egress by host (databases, SSH); a database a task uses is a service in its `needs`.
