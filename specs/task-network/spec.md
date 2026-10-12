# Feature Specification: Network Limits for Tasks and Services

**Created**: 2026-10-12

**Status**: Design, not implemented (ADR-0011)

**Input**: Every container task and service is on the docker default network and reaches whatever the host reaches. An agent's work (and an untrusted install script) should reach the services it needs and a package registry, not the rest of the network. Pascal decided it is a general feature for all tasks and services, with levels and a host allowlist in the first version.

## The field

```yaml
tasks:
  test:
    network: none                     # nothing at all
  e2e:
    needs: [db]
    network: needs                    # only the services in needs
  install:
    network: { allow: [registry.npmjs.org, '*.githubusercontent.com'] }   # needs + these hosts
  deploy:
    network: open                     # what the host reaches; the default, as today
```

| Level | Reaches | Docker | Kubernetes |
|---|---|---|---|
| `open` (default) | everything the host reaches | default bridge, as today | no policy |
| `allow: [hosts]` | its `needs` and HTTP(S) to the listed hosts | an internal network per run and an egress proxy container that allows `CONNECT` by host name; `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` (the needed services) set for the task | `NetworkPolicy` to the proxy pod and the services |
| `needs` | only the services in its `needs` | an internal network per run (`Internal: true`), services attached by name | `NetworkPolicy` to the services' pods |
| `none` | nothing | `NetworkMode: none` | deny-all `NetworkPolicy` |

## User Scenarios & Testing _(mandatory)_

1. **Given** `network: none`, **When** the task runs `curl https://example.com`, **Then** it fails to resolve or connect.
2. **Given** `network: needs` and `needs: [db]`, **Then** the task reaches `db` by its name and nothing else.
3. **Given** `allow: [registry.npmjs.org]`, **Then** `npm ci` succeeds and `curl https://example.com` fails; a tool that ignores the proxy variables finds no route out.
4. **Given** `network: none` together with `needs`, **Then** validation fails naming the task.
5. **Given** a local task with `network: needs`, **Then** validation fails: hammerkit can't limit the host's network.
6. **Given** `hammerkit run --network needs`, **Then** every task of the run is limited to at most `needs`; a task with `open` or `allow` gets `needs`, and a local task fails.
7. **Given** a service with `allow: [api.stripe.com]`, **Then** the service reaches that host, and tasks that need the service still reach it.

## Requirements _(mandatory)_

- **FR-001**: `network` on container tasks and services: `open` (default), `needs`, `none`, or `{ allow: [hosts] }`. A host is a name or `*.` and a domain; no ports, no IP ranges.
- **FR-002**: The levels are ordered `none` < `needs` < `allow` < `open`. A ceiling clamps a more open setting down to it, and an `allow` list under an `allow` ceiling is cut to the hosts both lists have.
- **FR-003**: `run --network <level>` and `up --network <level>` set a ceiling for the run, from outside the build file.
- **FR-004**: `network` other than `open` on a local task, or a ceiling below `open` with a local task in the run, is an error before anything runs.
- **FR-005**: The proxy for `allow` is started once per run on the run's internal network, removed with the run, and logs each refused host as a run event (`network: refused <host>`), so a failing install says why.
- **FR-006**: Not part of the cache key: the setting decides whether a task can work, not what a successful one produces.
- **FR-007**: Ingress is unchanged: tasks that need a service reach it, and ports published to the host stay published.
- **FR-008 (server)**: `runs.network` in the server config is the ceiling for every run, and the hosts any `allow` may list. A published version asking for more is refused at publish. `sandboxes.network` is the ceiling for runs on a sandbox (default `needs`).

## Out of scope

- Limiting local tasks (it would need OS sandboxing per platform).
- Non-HTTP egress by host (databases, SSH) other than through `needs`.
