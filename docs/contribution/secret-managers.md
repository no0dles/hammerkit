# Secret managers (planned)

> **Status: DEFERRED to 1.7.0.** Out of scope for the 1.6.0 release (feature freeze).
> Decisions are locked in (see Context); pick this up as a 1.7.0 feature.

## Context

Hammerkit currently resolves task/service environment variables in one of two ways
(`src/environment/replace-env-variables.ts`):

- literal values (`KEY: value`), and
- `$VAR` references resolved at **parse time** from `process.env` or `.env` files.

There is no way to source an env var from an external secret manager (Vault, AWS/GCP,
1Password, etc.), and resolved values are printed verbatim in logs and container
options — no redaction.

This change adds a **pluggable secret-provider** mechanism, modeled on the existing
**cache-backend** system (`src/cache/cache-backend*.ts`, `src/cache/resolve-cache.ts`),
plus log redaction. Per the decisions taken:

- **Reference style:** inline in `envs:` via a `secret://<provider>/<name>` value.
- **First provider:** `command` (runs a shell command, uses stdout as the secret) —
  zero new dependencies, works with any secret CLI. The abstraction leaves room for
  Vault/AWS/GCP providers later.
- **Masking:** resolved secret values are redacted (`***`) everywhere hammerkit writes.

### Example

```yaml
secrets:                                    # top-level provider catalog (like caches:)
  vault:
    type: command
    command: "vault kv get -field={{name}} secret/app"

tasks:
  deploy:
    image: deployer
    envs:
      DB_PASSWORD: secret://vault/db-password   # -> runs the command, {{name}}=db-password
      LOG_LEVEL: info
```

## Design overview

- A named **provider catalog** is declared at the top level (`secrets:`), mirroring
  `caches:`. Each entry is a discriminated-union spec keyed by `type`.
- Env values starting with `secret://` become a new **secret binding** on
  `WorkEnvironmentVariables`, carrying the env key, the resolved provider **spec**, and
  the secret name. The spec travels with the binding (as cache backends do via the
  `WeakMap` in `resolve-cache.ts`), so executors never need the catalog threaded to them.
- **Resolution is lazy/async at execution time.** This is mandatory: provider calls do
  I/O and may need credentials, so they must not run for `ls`/`validate`/clean, for tasks
  that never execute, or during cache-key computation.
- **Two resolution paths over the same bindings:**
  - sync `getEnvironmentVariables(envs)` — unchanged callers (notably the cache
    description) get the literal `secret://provider/name` **reference string** for a
    secret key. The cache key thus invalidates when the *wiring* changes but never
    embeds or fetches the secret value.
  - async `resolveEnvironmentVariables(envs, environment)` — execution path; fetches each
    secret via its provider, registers the value for redaction, returns real values.

## Files to add

- `src/schema/secret-schema.ts` — Zod specs (mirror `src/schema/cache-schema.ts`):
  - `secretProviderCommandSchema = object({ type: literal('command'), command: string() }).strict()`
    (`command` is a template; `{{name}}` is replaced with the secret name).
  - `secretProviderSchema = union([secretProviderCommandSchema])` (single-member now,
    extend for `vault`/`aws-secrets-manager`/`gcp-secret-manager` later).
- `src/secret/secret-provider.ts` — `SecretProvider { type: string; resolve(name, environment): Promise<string> }`
  + `SecretProviderFactory` (mirror `src/cache/cache-backend.ts`).
- `src/secret/secret-provider-registry.ts` — `registerSecretProvider(type, factory)` /
  `createSecretProvider(spec)`; registers the builtin `command` factory
  (mirror `src/cache/cache-backend-registry.ts`).
- `src/secret/providers/command-secret-provider.ts` — runs `command` with `{{name}}`
  substituted via `child_process.exec` (follow `src/executer/execute-command.ts`:
  `PATH` from `environment.processEnvs`, honor `environment.abortCtrl.signal`); returns
  trimmed stdout; throws on non-zero exit.
- `src/secret/resolve-secret-provider.ts` — `SecretCatalog` type + `getProviderSpec(catalog, name)`
  lookup (throws on unknown provider, like `resolveByName` in `resolve-cache.ts`), and a
  `WeakMap<spec, SecretProvider>` instance cache (mirror `getBackend` in `resolve-cache.ts`).
- `src/secret/secret-registry.ts` — `createSecretRegistry(): SecretRegistry` with
  `register(value: string)` and `redact(text: string): string` (replace each registered
  non-empty value with `***`). Ignore empty/very-short values to avoid over-masking.
- Tests/fixtures:
  - `src/secret/providers/command-secret-provider.spec.ts`
  - extend `src/environment/replace-env-variables.spec.ts` for `secret://` parsing +
    sync placeholder behavior
  - `src/testing/integration/secret.spec.ts` (end-to-end with a `command` provider, e.g.
    `printenv`/`echo`-style command) and `examples/secret/.hammerkit.yaml`

## Files to modify

- `src/schema/build-file-schema.ts` — add `secrets: record(secretProviderSchema).optional()`.
- `src/schema/reference-parser.ts` — add `secrets: SecretCatalog` to `ReferencedContext`
  and populate it from the build file's top-level `secrets:` (mirror how `caches` is
  threaded into the context).
- `src/environment/replace-env-variables.ts`:
  - Extend `WorkEnvironmentVariables` with `secrets: EnvironmentVariableSecret[]`
    (`{ key; name; ref; spec }`).
  - In `buildEnvironmentVariables`, detect `value.startsWith('secret://')`, parse
    `<provider>/<name>` (split on the first `/`, so names may contain `/`), look the
    provider up in `context.secrets` (parse-time validation), and push a secret binding
    carrying the spec.
  - `getEnvironmentVariables` (sync): for secret keys, set `result[key] = ref` (the
    literal `secret://...` string) — no I/O, stable for cache keys.
  - Add `async resolveEnvironmentVariables(envs, environment)`: variables + replacements
    as today, plus for each secret `createSecretProvider(spec).resolve(name, environment)`,
    `environment.secrets.register(value)`, then set `result[key] = value`.
- Executors — switch the **execution** path from sync to async resolve:
  - `src/executer/docker-task.ts` (move env resolution out of sync `buildCreateOptions`
    into the async `dockerTask`, or make `buildCreateOptions` async),
  - `src/executer/local-task.ts:19`,
  - `src/executer/docker-service.ts`,
  - `src/planner/work-runtime-kubernetes.ts` + `src/kubernetes/ensure-kubernetes-deployment-exists.ts`
    (resolve to plain `value`, consistent with current K8s env injection).
  - **Leave `src/optimizer/work-task-cache-description.ts` on the sync
    `getEnvironmentVariables`** — it must keep using the reference placeholder, not the value.
- `src/executer/environment.ts` — add `secrets: SecretRegistry` to the `Environment`
  interface. Instantiate it (`createSecretRegistry()`) at every construction site:
  `src/index.ts`, `src/testing/test-case.ts`, `src/testing/example-test-suite.ts`,
  `src/executer/environment-mock.ts`.
- `src/log.ts` — apply `env.secrets.redact(...)` inside the central writers
  (`writeWorkItemLogToConsole` and any direct stdout writer). This single chokepoint
  covers status messages, `printContainerOptions` output (it writes via `status.write`),
  and captured command stdout/stderr (`status.console('stdout', …)` in
  `execute-command.ts`), since all of these render through these writers. Verify the
  interactive/live loggers (`src/logging/interactive-logger.ts`, `live-logger.ts`) also
  funnel through `src/log.ts`; if a logger writes to stdout directly, redact there too.
- `package.json` — no new runtime dependency for the `command` provider.
- Regenerate `build.schema.json` (run the `json-schema` script, `src/json-schema.ts`) so
  the new `secrets:` field appears for IDE validation.

## Resolution & execution flow

1. Parse: `buildEnvironmentVariables` classifies each env value as variable / `$`
   replacement / `secret://` binding, validating the provider name against
   `context.secrets`.
2. Plan / cache: sync `getEnvironmentVariables` yields `secret://…` placeholders →
   cache description (`work-task-cache-description.ts`) is value-independent and offline.
3. Execute: executor calls `await resolveEnvironmentVariables(item.data.envs, environment)`
   → provider fetches value → registered for redaction → injected as a real env var.
4. Output: every log line passes through `env.secrets.redact()` → values shown as `***`.

## Verification

- `npm run test` — new unit specs (command provider, `secret://` parsing, sync
  placeholder) and the `src/testing/integration/secret.spec.ts` end-to-end run.
- Manual: with `examples/secret/.hammerkit.yaml` using a `command` provider such as
  `type: command, command: "echo my-secret-{{name}}"`, run `hammerkit run <task>` and
  confirm (a) the task receives the resolved value and (b) logs show `***` not the value.
- Confirm cache behavior: changing a secret's *value* (provider output) does NOT
  invalidate the task cache; changing the `secret://` *reference* DOES — verify the
  cache id via the existing `work-cache-id` tests/patterns.
- Run the contribution build gates (prettier, eslint, `tsc -b`, jest) before committing,
  and re-run the `json-schema` generation so `build.schema.json` is in sync.

## Out of scope (future)

- Additional providers (Vault HTTP, AWS Secrets Manager, GCP Secret Manager) — add a new
  spec to the `secretProviderSchema` union + a factory in the registry; the rest is
  unchanged. Cloud SDKs would become new dependencies at that point.
- Native Kubernetes `secretKeyRef` (creating a K8s Secret and referencing it instead of
  inlining the resolved value).
