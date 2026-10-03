# 0005: Registry cache entries are single-layer OCI image manifests

The `registry` cache backend stores each cache entry (task outputs) as a standard OCI **image manifest with a single tar layer**, not as an OCI artifact with a custom media type. A cache entry therefore looks like an ordinary one-layer image, so it works on every registry (Docker Hub, GHCR, ECR, GAR, Artifactory, plain `registry:2`) and reuses the image push/pull plumbing already built for `package <registry>`.

## Considered options

- **OCI artifact (custom `mediaType`)** — rejected: cleaner semantics, but older/stricter registries reject unknown media types, costing the portability that is the entire reason to use a registry as a cache. No concrete need for artifact typing.

## Consequences

- Mild lock-in: changing the format later invalidates existing cached entries — acceptable, since caches are regenerable.
- Revisit only if a concrete need for OCI-artifact typing appears.
