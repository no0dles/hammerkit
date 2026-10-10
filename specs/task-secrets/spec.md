# Feature Specification: Task & Service Secrets

**Feature Branch**: `015-task-secrets`

**Created**: 2026-05-31

**Status**: Implemented (1.11.0)

**Input**: Real-world feedback — some tests need GCloud pubsub credentials that the old CI provided. Hammerkit has no dedicated way to inject credentials into a containerized task; today there is only `envs`, env files, and `mounts`. This spec adds a first-class secrets mechanism for tasks and services that does not bake credentials into images or commit them to the build file.

## Motivation

Credentials like a GCloud service-account JSON or a pubsub key need to reach a containerized task without being committed to the repo or written into the image. The current options (`envs`, env files, raw `mounts`) either risk committing the value or provide no redaction and no Kubernetes story. A `secrets` declaration that *references* a source (a host env var or a file) and injects it as an env var or a mounted file — with the value redacted from logs and mapped to a k8s Secret on cluster — fills this gap.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Provide a credential from a host source (Priority: P1)

A developer declares a secret sourced from a host environment variable or a file (e.g. the GCloud credentials JSON) and injects it into the task as an env var or a mounted file — without putting the value in the build file.

**Why this priority**: This is the exact need — get CI-provided credentials into the task cleanly.

**Independent Test**: A task with a file-sourced secret sees the credential file at the declared target path inside the container; the build file contains only a reference, not the value.

**Acceptance Scenarios**:

1. **Given** a secret sourced from a host env var, **When** the task runs, **Then** the value is present as the declared environment variable inside the container.
2. **Given** a secret sourced from a host file, **When** the task runs, **Then** the file is mounted at the declared target path inside the container.
3. **Given** a build file declaring secrets, **When** it is inspected, **Then** it contains only references to sources, never the secret values.

### User Story 2 - Service parity (Priority: P1)

The same secrets mechanism applies to services, so a needed service (or the task using it) can receive credentials consistently.

**Why this priority**: Tasks and services share the runtime; an asymmetric secret story would be surprising.

**Independent Test**: A service with a declared secret receives it the same way a task does.

**Acceptance Scenarios**:

1. **Given** a service with a declared secret, **When** it starts (Docker or Kubernetes), **Then** it receives the secret via the declared env var or mount.

### User Story 3 - Kubernetes mapping & redaction (Priority: P2)

On Kubernetes, secrets map to a Secret resource consumed via env or volume and are cleaned up with the run. In all runtimes, secret values are redacted from logs.

**Why this priority**: Makes the feature safe and complete across the runtimes hammerkit targets.

**Independent Test**: Running on k8s creates a Secret consumed by the pod and removes it afterward; the secret value never appears in any logged output.

**Acceptance Scenarios**:

1. **Given** a k8s environment and a declared secret, **When** the task/service runs, **Then** a Secret resource backs the injection and is removed after the run.
2. **Given** any run with secrets, **When** output is produced, **Then** the secret value does not appear in logs.

### Edge Cases

- A missing/unresolvable source (env var unset, file absent) → fail fast with a clear error naming the secret, before the container starts.
- Secret value accidentally echoed by a task command → hammerkit MUST redact known secret values in its own logged output (it cannot control the task's stdout, but MUST NOT itself print the value).
- Cache interaction (resolved, ADR-0002): a secret value MUST NOT be written into the cache artifact or metadata. By default a secret does **not** participate in cache identity; a secret marked cache-affecting (`cache: true`) contributes a salted, non-reversible **digest** of its value to the task id — never the plaintext — so that an output-determining secret invalidates the cache when it changes. Default-off means a forgotten opt-in on an output-determining secret can yield a stale hit; this is the author's responsibility by design.
- k8s Secret lifecycle: leftover Secret from a crashed run → swept like other run-scoped resources.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Tasks and services MUST be able to declare `secrets`, each sourced from a host environment variable or a host file path.
- **FR-002**: Each secret MUST be injectable into the container as either an environment variable or a mounted file, per its declaration.
- **FR-003**: The build file MUST reference secret sources only; it MUST NOT require embedding secret values.
- **FR-004**: Secret values MUST be redacted from all output hammerkit itself logs.
- **FR-005**: On Kubernetes, secrets MUST map to a Secret resource consumed via env/volume, and that resource MUST be cleaned up with the run.
- **FR-006**: A missing or unresolvable secret source MUST fail fast with a clear error naming the secret, before the task/service starts.
- **FR-007**: Secret values MUST NOT be written into the cache artifact or into `description.json` (unlike `envs`, which persist in plaintext — secrets MUST NOT reuse the env path).
- **FR-007a**: A secret MUST default to *not* participating in cache identity. A secret marked cache-affecting (`cache: true`) MUST contribute a salted, non-reversible digest of its value to the task id (never the plaintext), so a change to an output-determining secret invalidates the cache (ADR-0002).
- **FR-008**: Tasks/services without secrets MUST behave exactly as today (additive, non-breaking — Stable Contracts).

### Key Entities

- **Secret**: a name, a source (`env:<NAME>` or `file:<path>`), a target (an environment variable name or an in-container mount path), and an optional `cache` flag (default `false`) marking it cache-affecting.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A task with a file-sourced secret sees the credential file at its target path; the build file holds no secret value.
- **SC-002**: A secret value never appears in any output hammerkit logs.
- **SC-003**: A missing secret source fails the run before the container starts, with a message naming the secret.
- **SC-004**: On Kubernetes, the backing Secret resource is created for the run and removed afterward.
- **SC-005**: A build file with no secrets behaves identically to the prior version.

## Assumptions

- v1 sources are **host env var** and **host file**. A secrets-manager source arrived as **secret providers** (ADR-0008): commands that print the value, read as a service account.
- Secrets are ambient credentials by default and do not participate in cache identity; the `cache: true` opt-in (ADR-0002) covers the case where a secret genuinely determines output.
- This mechanism is the supported path for credentials like the GCloud pubsub keys referenced in the feedback, replacing ad-hoc `mounts`/`envs`.
- Credential resolution reuses standard host mechanisms; it introduces no persistent secret storage of its own.

## Implementation notes (1.11.0)

- Schema: `secrets: [{ from: env:NAME | file:path, env | path, cache? }]` on tasks and container services; exactly one target per secret. A service's `init` gets the service's secrets.
- Values are read when the task or service starts (planning never reads them); a missing source fails the item before its container starts, naming the secret (FR-006).
- Docker: `env` targets are container env; `file:` sources are bind-mounted `:ro`; `env:` sources with a `path` target are written to an owner-only file in hammerkit's data directory, mounted `:ro` and removed with the container (a daemon service keeps it until `down`).
- Kubernetes: one Secret per task or service, referenced via `secretKeyRef` / a read-only `subPath` mount; a task's Secret is deleted after it ran, a service's on stop (FR-005).
- Local tasks take `env` targets only.
- Provider sources: `from: <provider>:<ref>` with `secretProviders:` (an argv `command`, `{{ref}}`, optional `env` and `timeout`) and `secretAccounts:` (per provider, the `env` that makes the command act as a service account, `${HOST_VARIABLE}` values) declared in any loaded build file and shared by includes (ADR-0008). A secret's account is its own `account`, else its task's or service's, else the `default: true` account. The command runs with `PATH`, the provider `env` and the account `env` only; an unset account variable, a failing, missing, slow or empty command fails the item naming the secret, provider and account. Values are fetched once per run per provider, account and reference, held in memory only. `cache: true` is not supported for provider secrets yet.
- Redaction: every value hammerkit reads is registered in the run's `SecretRegistry` (`Environment.secrets`, one per run, never global) and masked as `***` in all status and console output it writes, per line for multi-line values, together with its base64 (any alignment, URL-safe too), hex, URL-encoded and JSON-escaped forms; values under four characters are not masked, nor derived base64/hex forms under eight (FR-004).
- Cache: secrets stay out of the description by default; `cache: true` adds `name=sha256:<salted digest>`, with file targets named project-relative so the key matches across checkouts (FR-007, FR-007a).
- The service definition hash (recreate on `up`) covers secret declarations (for a provider secret its provider, reference and account), never values: a rotated value needs `down`.
