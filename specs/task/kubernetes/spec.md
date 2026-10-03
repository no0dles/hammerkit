# Feature Specification: Task: Kubernetes

**Feature Branch**: `001-current-state-specs`

**Created**: 2026-05-30

**Status**: Current State (reverse-specified from docs, hammerkit 1.6.0)

**Input**: Existing behavior documented in `website/content/docs/task/kubernetes.mdx`

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run tasks on a Kubernetes cluster (Priority: P1)

A developer wants to run their hammerkit tasks on a Kubernetes cluster rather than the local Docker daemon. They declare an environment with a `kubernetes` target in the build file and pass `--env <name>` when running a task. Tasks execute as Kubernetes jobs, services run as deployments, and caching works identically to local runs.

**Why this priority**: This is the headline feature introduced in 1.6.0; it enables cloud-based and reproducible remote execution from the same build file.

**Independent Test**: Declare a kubernetes environment pointing to a reachable cluster context, run `hammerkit <task> --env <name>`, and verify the task pod appears in the cluster and the task completes successfully.

**Acceptance Scenarios**:

1. **Given** an `environments` block with a kubernetes target, **When** the user runs `hammerkit <task> --env <name>`, **Then** the task executes as a Kubernetes job in the specified cluster context.
2. **Given** a service referenced by a task via `needs`, **When** the environment is kubernetes, **Then** the service runs as a Kubernetes deployment and its healthcheck is translated into readiness/liveness probes.
3. **Given** no `--env` flag is passed, **When** the user runs a task, **Then** hammerkit uses the local Docker daemon regardless of declared environments.

### User Story 2 - Configure the cluster connection (Priority: P1)

An operator needs to specify which cluster context, namespace, and kubeconfig file to use. They fill in the kubernetes target fields; `context` is required and the rest default to sensible values.

**Why this priority**: Without correct cluster targeting, tasks would run on the wrong cluster or fail to authenticate.

**Independent Test**: Declare an environment with a specific `namespace`; run a task and verify the resulting job is created in that namespace.

**Acceptance Scenarios**:

1. **Given** a kubernetes target with only `context` set, **When** a task runs in that environment, **Then** hammerkit uses `$HOME/.kube/config` and the default namespace.
2. **Given** a kubernetes target with `kubeconfig` and `namespace` set, **When** a task runs, **Then** the specified kubeconfig file and namespace are used.

### User Story 3 - Expose services via HTTP routes (Priority: P2)

An operator wants a deployed service to be reachable from outside the cluster. They add an `httpRoutes` entry under the kubernetes target with a hostname, service name and parent gateway. Hammerkit creates a Gateway API HTTPRoute resource pointing to the service. (Ingress resources were supported until 1.7 and removed in 1.8.0.)

**Why this priority**: Route configuration enables integration testing and end-to-end workflows that require external access to deployed services.

**Independent Test**: Declare an `httpRoutes` entry for a service, run in the kubernetes environment, and verify an HTTPRoute resource with the correct host, gateway and service reference is created in the cluster.

**Acceptance Scenarios**:

1. **Given** an `httpRoutes` entry with `host`, `service`, `servicePort` and `gateway`, **When** the environment is activated, **Then** hammerkit creates a Gateway API HTTPRoute attached to the named Gateway, routing that host to the service.
2. **Given** an `ingresses` list (removed in 1.8.0), **When** the build file is parsed, **Then** it is rejected with a message pointing to `httpRoutes`.

### User Story 4 - Target a remote Docker daemon (Priority: P3)

A developer wants to run tasks against a remote Docker daemon instead of the local one. They declare an environment with a `docker` target and optionally supply a `host` address.

**Why this priority**: Remote Docker is an alternative execution target that shares the environment declaration mechanism.

**Independent Test**: Declare a docker environment with a `host` pointing to a remote daemon; run a task with `--env <name>` and verify it executes on the remote daemon.

**Acceptance Scenarios**:

1. **Given** a docker environment target with a `host` address, **When** `hammerkit <task> --env <name>` is run, **Then** the task executes against the remote Docker daemon at that address.

### User Story 5 - Use `--env` with store and restore commands (Priority: P2)

A CI engineer stores build cache from a cluster run and restores it on another machine. The `--env` flag is available on the store and restore CLI commands, not just execute.

**Why this priority**: Remote cache round-tripping requires environment selection at storage time to address the right cluster outputs.

**Independent Test**: Run `hammerkit store --env <name>` after a cluster-based build and verify the result is stored correctly.

**Acceptance Scenarios**:

1. **Given** a completed kubernetes-environment task run, **When** the user runs `hammerkit store --env <name>`, **Then** the task results from the cluster are stored.
2. **Given** stored results from a cluster, **When** the user runs `hammerkit restore --env <name>`, **Then** the results are restored into the cluster environment.

### Edge Cases

- `context` is required for a kubernetes target; omitting it should cause a validation error.
- `kind: httproute` requires Gateway API CRDs and a `Gateway` resource to be installed in the cluster; hammerkit does not install these prerequisites.
- The `gateway` field is required when `kind: httproute` is used; `gatewayNamespace` is optional.
- The same environment declaration supplies cluster connection details for port-forward Kubernetes services (described in the service/kubernetes page), avoiding repetition.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST accept a top-level `environments` block where each entry targets either `kubernetes` or `docker`.
- **FR-002**: The system MUST accept a `--env <name>` CLI flag on the execute, store, and restore commands.
- **FR-003**: When `--env` is not supplied, the system MUST use the local Docker daemon.
- **FR-004**: A kubernetes target MUST require a `context` field identifying the kube context (cluster + user).
- **FR-005**: A kubernetes target MUST support optional `namespace`, `kubeconfig`, and `httpRoutes` fields.
- **FR-006**: When `kubeconfig` is not specified, the system MUST default to `$HOME/.kube/config`.
- **FR-007**: The system MUST execute tasks as Kubernetes jobs and container services as Kubernetes deployments when running in a kubernetes environment.
- **FR-008**: A service healthcheck MUST be translated into Kubernetes readiness and liveness probes on the corresponding deployment.
- **FR-009**: The system MUST support an `httpRoutes` list on a kubernetes target, creating a Gateway API HTTPRoute resource per entry.
- **FR-010**: An `httpRoutes` entry MUST require `host`, `service` and `gateway`; `servicePort`, `path` and `gatewayNamespace` are optional.
- **FR-012**: A docker environment target MUST support an optional `host` field for a remote Docker daemon address.
- **FR-013**: Task caching MUST function identically in kubernetes environments as in local docker runs.

### Key Entities

- **Environment**: A named entry in `environments` specifying either a `kubernetes` or `docker` execution target.
- **Kubernetes target**: Configuration for cluster execution: `context` (required), `namespace`, `kubeconfig`, `httpRoutes`.
- **Docker target**: Configuration for docker execution: `host` (optional).
- **HTTP route entry**: Route configuration with `host`, `service`, `gateway`, `servicePort`, `path`, `gatewayNamespace`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A task run with `--env <kubernetes-env>` creates a job in the target cluster and produces the same output as a local run.
- **SC-002**: A service with a healthcheck deployed via a kubernetes environment has readiness and liveness probes on its deployment.
- **SC-003**: An `httpRoutes` entry creates a Gateway API HTTPRoute resource attached to the specified Gateway, with the correct host and backend service; `hammerkit down` removes it.
- **SC-004**: A build file declaring `ingresses` is rejected with a message pointing to `httpRoutes`.
- **SC-005**: Without `--env`, tasks run on the local Docker daemon regardless of declared environments.

## Assumptions

- "Same caching behavior" means checksum/modify-date/none methods and remote backends all work the same way in a kubernetes environment as locally.
- The kubernetes environment feature was introduced in hammerkit 1.6.0; earlier versions do not support it.
- Port-forward Kubernetes services (described separately in service/kubernetes.md) can reuse the cluster connection declared in an environment via `--env`, but this page does not specify that detail further.
