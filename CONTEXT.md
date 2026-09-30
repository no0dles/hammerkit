# Hammerkit

Containerized build tool with incremental caching that runs the same build file locally, on Docker, and on Kubernetes.

## Language

### Build graph

**Task**:
The primary unit of work — a set of commands run on the host or in a container, with declared `src` inputs and `generates` outputs.
_Avoid_: job, step, node (the old internal name for this concept; now "task")

**Service**:
A long-lived container a task depends on at runtime (e.g. a database), reached via `needs`.
_Avoid_: dependency container, sidecar

**Need**:
A task→service runtime dependency. Distinct from `deps`, which is a task→task ordering dependency.
_Avoid_: requirement, link

### Caching

**State key**:
A hash of a task's `src` file *contents* (under the cache method) folded with its dependencies' state keys. It captures input-file changes only — **not** the command, image, or env, which live in the task id. A false hit (serving a stale entry as fresh) is a defect, never a speed trade.
_Avoid_: cache key, fingerprint

**Task id**:
A sha1 hash of the task *definition* — command, image, env, mounts, shell, `src` paths, `generates`, cwd, deps. Changing any of these yields a new id, and thus a fresh cache location. A cache entry is addressed by **task id + state key**: the id captures *what the task is*, the state key captures *what its inputs contain*.
_Avoid_: cache id, task hash

**Cache backend**:
A store that holds task output artifacts addressed by task id + state key (`local`, `s3` and `registry`).
_Avoid_: cache store, cache provider

**Local cache**:
The on-machine cache backend a build reads and writes during a run. The default cache is local. A build only ever touches the local cache directly.
_Avoid_: cache dir, local store, working cache

**Remote backend**:
An off-machine cache backend (S3, registry). `cache pull`/`cache push` sync entries between the local cache and a remote backend named via `--remote`, so the build itself does no network I/O. (A task can still use a remote backend as its own cache — the 1.6 inline mode — in which case the build pulls and pushes it directly.)
_Avoid_: remote cache, origin cache

### Remote includes

**Remote reference**:
A `references`/`includes` entry that resolves a build file from a **git** repository at a branch, tag, or commit. The first resolution caches the fetched repo locally and that cached copy is reused until refreshed (by a pull command or `clean --cache`) — the **cache, not a lockfile, is the pin**. A commit SHA is the opt-in for cross-machine reproducibility.
_Avoid_: remote import, url include (there is no HTTP transport)

### Secrets

**Secret**:
A credential injected into a task/service at runtime from a host env var or file — referenced (never embedded) in the build file and redacted from logs. By default a secret does **not** affect cache identity; it is marked cache-affecting (opt-in) when its value determines output, contributing a salted value digest — never the plaintext — to the task id.
_Avoid_: credential, env (a `Secret` is distinct from a plain `env`, which is stored in plaintext and always cache-affecting)
