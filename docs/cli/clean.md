---
description: Clear all generated files and folders to get a fresh mind.
---

# Clean

This command cleans up all generated directories and files including the local
cache state of hammerkit.
This can be useful to detect errors in the build file and verifying if all tasks work without a previous state.

```
hammerkit clean
```

## Clearing stored cache results

By default `clean` removes the generated outputs and the per-task cache state of
the current checkout. Add `--cache` to also drop the **stored results** kept by
the cache backend - the local result store under `~/.hammerkit/remote-cache` or a
configured remote backend (for example an S3 bucket).

```
hammerkit clean --cache
```

This forces the next run to rebuild from scratch instead of restoring a result
from the backend. See [caches](../build-file/caches.md) for how backends work.

{% hint style="info" %}
`--filter`/`--exclude` label options apply to `clean` as well, so you can clean a
subset of tasks and services.
{% endhint %}
