# 0008: Secret providers are commands, read as service accounts

A secret's `from` can name a **provider** (`from: gsm:db-password`) next to `env:` and `file:`. A provider is an argv `command` that prints the value (`{{ref}}` is the reference); `secretAccounts` say which service account it is read as. Both are build-file blocks collected across all loaded files, so a company declares them once in a file every project includes.

## Why

- The core must not know Google Secret Manager or 1Password. A command with a `{{ref}}` placeholder covers both and any CLI that follows, and the shared company file is the preset, owned by the company instead of by hammerkit. A native SDK provider stays possible as another member of the provider union (`registerSecretProvider`), the way cache backends are registered.
- Authentication is bound to a service account, never a person. The command runs with `PATH`, the provider `env` and the account `env` only, and an account's values are `${HOST_VARIABLE}` references that must be set. A personal `gcloud auth login` or the 1Password app is never picked up by accident, and a missing credential fails instead of falling back to one.
- The machine that runs hammerkit holds the credentials and resolves the value itself; nothing secret is passed between machines, and build files hold no credential.
- One seam resolves a value (`resolveSecretValue`), so delivery to Docker, Kubernetes and local tasks, masking and the cache rules (ADR-0002) do not change.

## Rules

- No shell: `command` is a list, a reference starting with `-` is rejected, and the recipes put it in `--secret={{ref}}` form, so a reference never becomes an option.
- Values are verbatim (a key file keeps its newline), fetched once per run per provider, account and reference, in memory only. An empty value, non-zero exit, missing binary, timeout and unset account variable fail the item naming the secret, provider and account.
- Provider and account names are global; a name declared in two files is an error. Providers and accounts declared in a git include require `ref` to be a full commit SHA, since a moved tag would run with the credentials of a service account.
- Planning never fetches (`ls`, `validate`).

## Considered options

- **Vendor presets and SDKs** (`type: gsm`): hammerkit would own two vendors' flags, dependencies and release cycles. Kept as a later union member.
- **Providers and accounts only in host configuration**: guards against a pull request redefining a provider, at the cost of projects that are not self-contained. Build code is trusted, so reviewed build files are the place; a later move of two blocks if that changes.
- **`secret://provider/name` inside `envs`**: puts the value in the plaintext, always cache-affecting path.

## Consequences

- Additive: two optional top-level keys, `account` on tasks, container services and secrets, and a wider `from` pattern.
- `cache: true` is not supported for provider secrets in the first version: the task id is computed synchronously and needs the value fetched beforehand.
- A task that receives a secret can print it, and so can the code it runs. Masking reduces accidents, it is not a boundary.
