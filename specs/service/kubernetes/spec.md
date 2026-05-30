# Feature Specification: Service: Kubernetes

**Feature Branch**: `001-current-state-specs`

**Created**: 2026-05-30

**Status**: Current State (reverse-specified from docs, hammerkit 1.6.0)

**Input**: Existing behavior documented in `docs/service/kubernetes.md`

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Forwarding a Kubernetes deployment port to a local task (Priority: P1)

A developer wants to run a local task against a staging database that lives in a Kubernetes cluster. They declare an environment with the cluster context, declare a Kubernetes service with a `selector` pointing to the deployment and the ports to forward, then run their task with `--env staging`. Hammerkit establishes the port-forward and the task reaches the database on localhost.

**Why this priority**: This is the primary use case of Kubernetes services — accessing remote cluster resources locally without leaving the hammerkit workflow.

**Independent Test**: Declare a `prod` environment with a valid kubeconfig context and a service selecting a known deployment. Run `hammerkit <task> --env prod` and confirm the task can connect on the forwarded port.

**Acceptance Scenarios**:

1. **Given** an environment declares a Kubernetes `context` and a service declares a `selector` with `type: deployment` and a `name`, **When** a task needing the service is run with `--env <env>`, **Then** hammerkit forwards the specified ports from the matching deployment to localhost.

2. **Given** an environment named `default` exists in the build file, **When** a task is run without `--env`, **Then** hammerkit uses the `default` environment automatically.

3. **Given** the same service definition, **When** the task is run with `--env local` versus `--env prod`, **Then** the port-forward targets the cluster configured in the respective environment.

### User Story 2 - Overriding the namespace or context per service (Priority: P2)

A developer has a `prod` environment pointing to a GKE cluster with a default namespace of `databases`, but one service lives in the `orders` namespace. They add `namespace: orders` on that service to override only the namespace while inheriting everything else from the environment.

**Why this priority**: Per-service overrides allow a single build file to target resources spread across multiple namespaces without duplicating environment definitions.

**Independent Test**: Declare an environment with `namespace: databases` and a service that overrides `namespace: orders`. Verify the port-forward targets the `orders` namespace.

**Acceptance Scenarios**:

1. **Given** an environment declares `namespace: databases` and a service declares `namespace: orders`, **When** the service is activated, **Then** the port-forward targets the `orders` namespace, not `databases`.

2. **Given** a service declares neither `namespace`, `context`, nor `kubeconfig`, **When** it is activated, **Then** it inherits all three from the selected environment.

### User Story 3 - Connecting to different cloud providers (Priority: P3)

A developer's team uses GKE for prod and EKS for staging. They configure two environments with the appropriate context names written by the cloud CLI tools. Services are declared once and are provider-agnostic.

**Why this priority**: Multi-provider support broadens the tool's applicability but is a configuration concern, not a behavioral distinction.

**Independent Test**: Declare two environments with provider-specific context names and run the same service-needing task against each; verify the correct cluster is targeted each time.

**Acceptance Scenarios**:

1. **Given** a GKE environment with context `gke_<project>_<location>_<cluster>`, **When** a task is run with that environment, **Then** hammerkit connects to the GKE cluster via the matching kubeconfig entry.

2. **Given** an AKS environment with a dedicated `kubeconfig` file, **When** a task is run with that environment, **Then** hammerkit uses the specified kubeconfig file rather than the default `~/.kube/config`.

### Edge Cases

- If no matching deployment, service, or pod exists in the target cluster namespace, the port-forward fails and the task does not start.
- If neither the service nor the environment specifies a `namespace`, hammerkit defaults to the `default` Kubernetes namespace.
- The `kubectl` binary is not required; hammerkit performs port-forwarding directly through the Kubernetes client library.
- A service can override `context` or `kubeconfig` individually while still inheriting the other fields from the environment.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST forward ports from a Kubernetes resource to localhost using the `selector` (type and name) and `ports` declared on the service.
- **FR-002**: System MUST resolve the cluster connection (`context`, `kubeconfig`, `namespace`) from the environment selected via `--env`.
- **FR-003**: System MUST use the environment named `default` when no `--env` flag is provided and such an environment exists.
- **FR-004**: System MUST allow a service to override `namespace`, `context`, and/or `kubeconfig` independently, inheriting unoverridden fields from the environment.
- **FR-005**: System MUST support `selector.type` values of `deployment`, `service`, and `pod`.
- **FR-006**: System MUST establish port-forwarding without requiring the `kubectl` binary on the host.
- **FR-007**: System MUST default to the environment's `kubeconfig`, falling back to `$HOME/.kube/config` when neither the service nor the environment specifies one.
- **FR-008**: System MUST default to the environment's `namespace`, falling back to `default` when neither specifies one.

### Key Entities

- **Kubernetes Service**: A service entry with `selector` (resource `type` and `name`), `ports` (host:container mappings), and optional `namespace`, `context`, `kubeconfig` overrides.
- **Environment**: A named block under `environments` containing a `kubernetes` sub-key with `context`, optional `kubeconfig`, and optional `namespace`.
- **Selector**: Specifies the Kubernetes resource to forward from. Fields: `type` (deployment | service | pod) and `name`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A task that needs a Kubernetes service can connect to the forwarded port on localhost while the task runs, verified by a successful network call.
- **SC-002**: Switching `--env` between two environments with different cluster contexts results in the port-forward targeting the correct cluster, confirmed by which database responds.
- **SC-003**: A per-service `namespace` override causes the forward to target the overriding namespace, not the environment's default namespace.
- **SC-004**: Port-forwarding succeeds on a machine that does not have `kubectl` installed.

## Assumptions

- Each port mapping in `ports` follows `hostPort:containerPort` notation; hammerkit binds `hostPort` on localhost and forwards to `containerPort` on the selected Kubernetes resource.
- The `--env` flag is the only mechanism for selecting a Kubernetes environment at runtime; there is no interactive prompt.
- Kubernetes services in hammerkit are for port-forwarding only — they do not schedule workloads on the cluster (see task/kubernetes.md for running tasks on a cluster).
- A Kubernetes service without an explicit `image` field is distinguished from a container service by the presence of a `selector` field.
