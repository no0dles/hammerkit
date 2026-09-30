---
description: >-
  Move cache entries between a machine and a remote cache without running
  anything — warm a workspace before a build, upload after it.
---

# Cache pull / push

`hammerkit cache pull` and `hammerkit cache push` move cache entries between each
task's own cache (by default the machine-local `default` cache) and a **remote**
cache declared in the [`caches:`](../build-file/caches.md) block. They execute no
task and start no container.

Only the entries for the tasks' **current** state are moved — exactly what the next
build of this commit looks up — including all transitive dependencies of the
selected tasks.

{% code title=".hammerkit.yaml" %}
```yaml
caches:
  shared:
    method: checksum
    backend:
      type: s3
      bucket: my-build-cache
```
{% endcode %}

```bash
# fast workspace setup: fetch everything the build needs, then build offline
hammerkit cache pull --remote shared
hammerkit run build

# after a trusted build: upload the results for everyone else
hammerkit cache push build --remote shared
```

## Options

```
Usage: hammerkit cache pull|push [options] [task]

Options:
  --remote <name>           remote cache declared in the caches block
  -f, --filter <labels...>  filter task and services with labels
  -e, --exclude <labels...> exclude task and services with labels
  --env <name>              environment
  --cache <method>          caching method to compare (choices: "checksum", "modify-date", "none")
```

## Behavior

* An entry already present at the destination is skipped, so both commands are
  safe to re-run.
* An entry missing at the source is reported and skipped — the command still
  succeeds.
* An unreachable or unauthorized remote **fails** the command (unlike a build,
  where a cache error only degrades to a cache miss).
* `cache push` refuses to run when `HAMMERKIT_CACHE_READ_ONLY` is set.
* Tasks with `cache: none`, or tasks whose own cache already *is* the remote, are
  skipped.
