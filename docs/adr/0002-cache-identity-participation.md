# What participates in cache identity

Cache identity (the **task id**) is a content hash of the fields that determine a task's *output*: command, image, CPU architecture, env, mounts, shell, `src` paths, `generates`, cwd, and the task ids of its deps (so a change to a dependency's definition reaches every task depending on it). The new schema surfaces added in 1.7 are governed as follows:

- **Resource limits, task timeout, container runtime/security options — do NOT participate.** They affect *whether and how* a task runs, not its output; including them would churn the cache on routine tuning (bumping a memory limit, relaxing seccomp to unblock a syscall).
- **Matrix values — participate automatically.** They substitute into command/image/env, which are already in the description, so each instance gets a distinct id for free.
- **Secrets — do NOT participate by default; opt in per secret.** Most secrets are ambient credentials whose rotation must not bust the cache. A secret may be marked cache-affecting (`cache: true`), which contributes a **salted, non-reversible digest** of its value to the id — never the plaintext — so that an output-determining secret (e.g. an `API_ENV` toggle, a seed-data token) invalidates the cache when it changes.

## Considered options (secrets)

- **Always-digest** (every secret participates) — rejected: a credential rotation to a new value with identical effect would spuriously bust the cache.
- **Per-secret opt-out** (participate by default) — rejected: the common case is an ambient credential that should *not* affect the cache, so non-participation is the safer default; opt-in makes the output-determining intent explicit.

## Consequences

- **Deliberate trade-off**: with secrets default-off, an output-determining secret the author forgets to opt in can yield a stale hit. This is accepted as the author's responsibility, chosen over churning the cache on every credential rotation.
- Env *values* participate in the id, but what is stored — `description.json` (pushed to remote backends) and the local `explain` record — carries only an unsalted sha256 digest of each value. A digest of a low-entropy value is guessable, so secrets MUST NOT reuse the env path — opted-in secrets persist only a salted digest, never the value.
- A digest of a low-entropy secret is theoretically brute-forceable from metadata, so the digest is salted with a stable per-project value (stable so remote-cache ids still match across machines).
