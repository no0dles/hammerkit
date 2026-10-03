# 0006: Cache identity is checkout-independent; runtime state is checkout-scoped

A task/service **id** (the cache key) is computed from a description whose paths are expressed relative to the **project root** — the nearest ancestor with a `.git` entry, falling back to the directory of the main build file — with paths under the home directory written as `~/…`. The same project therefore gets the same ids in an agent sandbox (`/workspace/app`), a CI runner (`/home/runner/work/app/app`) and a laptop, which is what lets a shared remote cache actually hit.

Machine-local runtime state — docker container labels (`hammerkit-id`) and the cache staging directory — is keyed by a separate **instance id** (`getWorkInstanceId`: the portable id folded with the absolute project root). Two worktrees of the same repo on one host share cache entries but never each other's paused containers or staging files.

## Considered options

- **Relative to the main build file directory** — rejected: the root would move with `-f apps/web/.hammerkit.yaml` vs running from the repo root, giving different ids for the same task depending on how it was invoked.
- **Relative to each task's own `cwd`** — rejected: two packages with byte-identical build files (a `lint` task in every package) would collide on one id, and ids are also used for runtime state.
- **Use the portable id for runtime state too** — rejected: docker's "already built" check finds the paused container by id while outputs live in per-path volumes, so a second checkout would report a false hit with empty volumes.

## Consequences

- Upgrading changes every id once, so the first run after upgrading is a full cache miss.
- The built-in `default` cache (`~/.hammerkit/remote-cache`) is now actually shared between checkouts on one machine, as documented.
- Local tasks still include the host OS in their identity; only container tasks share across macOS/Linux, and only on the same CPU architecture (outputs hold native binaries, and docker pulls images for the host architecture).
- Kubernetes resource labels still use the portable id; two checkouts deploying the same service into one namespace already collide on resource names.

Since ADR 0007 the runtime state of a container task is a state file under the instance id, not a paused container.
