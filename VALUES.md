# Values

This file is the canonical statement of what hammerkit optimizes for and the conventions that follow from it. Contributors and AI agents should read it before non-trivial work. Day-to-day agent operating rules live in [AGENTS.md](AGENTS.md); durable corrections live in [.agents/FEEDBACK.md](.agents/FEEDBACK.md).

## Product values

### Local-first

Hammerkit must be usable on a developer's laptop, not only in CI. A build tool that only runs on CI is broken.

### Platform-agnostic

No coupling to GitHub Actions, GitLab CI, or any single provider. The same build runs anywhere a container does.

### One config, many tools

A single hammerkit build file replaces N tool-specific configs. Reducing config sprawl is a feature, not a side effect.

### Caching reduces waste, not just time

Smart, distributed caching saves compute — that matters for cost and footprint, not only build speed.

## Engineering values

### Stable foundation

The CLI and build-file schema are contracts. Breaking them is a deliberate, versioned decision — never a refactor side effect.

### Simplicity & composability

Prefer small, composable pieces over clever abstractions. If two features can be one, make them one.

### Pragmatic typing

TS strict is on; `any` is permitted where it pulls its weight. Type purity is a means, not the goal.

### Tests carry their weight

Quality and coverage are non-negotiable. Slow integration tests are accepted because they buy real confidence.

## Decision heuristics

### Fix root causes, not symptoms

A red check is fixed by repairing what's broken — not by removing, muting, or weakening the check.

### Real integrations over mocks

Where feasible, exercise real Docker / real registries / real Kubernetes. Mocks are a last resort, not a default.

### Add nothing speculative

Features, abstractions, and config knobs land when a concrete need exists — not for hypothetical futures.
