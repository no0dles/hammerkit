<!--
SYNC IMPACT REPORT
Version change: (uninitialized template) → 1.0.0
Rationale: Initial ratification. Constitution materialized from the canonical
VALUES.md; no prior versioned principles existed.

Modified principles: none (all newly defined)
Added principles:
  - I. Local-First
  - II. Platform-Agnostic
  - III. One Config, Many Tools
  - IV. Caching Reduces Waste
  - V. Stable Contracts (NON-NEGOTIABLE)
  - VI. Simplicity & Composability
  - VII. Pragmatic Typing
  - VIII. Tests Carry Their Weight (NON-NEGOTIABLE)
Added sections:
  - Decision Heuristics
  - Development Workflow & Quality Gates
  - Governance
Removed sections: none

Templates reviewed for alignment:
  - .specify/templates/plan-template.md ............ ✅ Constitution Check gate is
      generic ("Gates determined based on constitution file"); Complexity Tracking
      already supports Principle VI / "Add nothing speculative". No edit required.
  - .specify/templates/spec-template.md ............ ✅ No principle conflict. No edit.
  - .specify/templates/tasks-template.md ........... ✅ Tests-optional wording does
      not contradict Principle VIII (which governs the product, not generated
      task lists). No edit required.
  - .specify/templates/checklist-template.md ....... ✅ No principle conflict. No edit.

Follow-up TODOs: none. RATIFICATION_DATE set to 2026-05-30 (initial adoption).
-->

# Hammerkit Constitution

## Core Principles

### I. Local-First

Every hammerkit build MUST run on a developer's laptop, not only in CI. A feature that
functions exclusively inside a CI environment is incomplete. Local execution is the
primary target; CI is one consumer among many.

**Rationale**: A build tool that only runs on CI is broken.

### II. Platform-Agnostic

Hammerkit MUST NOT couple its core to any single CI/CD provider (GitHub Actions, GitLab
CI, or otherwise). The same build MUST run anywhere a container runs. Provider-specific
behavior is prohibited in core and, where genuinely needed, MUST sit behind a clear
boundary.

**Rationale**: Portability across environments is a core promise, not a configuration
option.

### III. One Config, Many Tools

A single hammerkit build file MUST be able to replace many tool-specific configs. Changes
SHOULD reduce config sprawl, not add to it; any new configuration surface MUST justify its
existence against this goal.

**Rationale**: Reducing config sprawl is a feature, not a side effect.

### IV. Caching Reduces Waste

Caching MUST be evaluated for compute and cost savings, not only wall-clock speed.
Distributed and smart caching is a first-class concern. Cache-key correctness is
non-negotiable: a false cache hit (serving stale output as fresh) is a defect, never an
acceptable trade for speed.

**Rationale**: Smart caching saves compute — that matters for cost and footprint, not only
build time.

### V. Stable Contracts (NON-NEGOTIABLE)

The CLI surface and the build-file schema are public contracts. Backward-incompatible
changes to either MUST be deliberate and versioned — never an incidental side effect of a
refactor. A breaking change requires a MAJOR version bump and migration notes.

**Rationale**: Users depend on these contracts; silent breakage erodes trust in the tool.

### VI. Simplicity & Composability

Prefer small, composable pieces over clever abstractions. If two features can be one, make
them one. Abstractions, features, and config knobs MUST NOT land without a concrete present
need (YAGNI).

**Rationale**: Composable simplicity keeps the system maintainable and keeps the surface
area honest.

### VII. Pragmatic Typing

TypeScript strict mode MUST stay enabled. `any` is permitted where it pulls its weight;
type purity is a means, not the goal. Type-level cleverness MUST NOT be bought at the cost
of readability or delivery velocity.

**Rationale**: Types exist to serve correctness and developer experience, not the reverse.

### VIII. Tests Carry Their Weight (NON-NEGOTIABLE)

Quality and coverage are non-negotiable. New behavior ships with tests that would fail
without it. Slow integration tests are accepted because they buy real confidence. Tests
MUST NOT be skipped, muted, excluded, `xfail`-ed, or weakened to make a check pass; close
gaps, do not exclude them.

**Rationale**: Real confidence beats a green checkmark earned by lowering the bar.

## Decision Heuristics

When a judgment call is not settled by a principle above, apply these heuristics (verbatim
from `VALUES.md`):

- **Fix root causes, not symptoms** — A red check is fixed by repairing what's broken, not
  by removing, muting, or weakening the check (no skipped tests, no relaxed lint/prettier
  config to dodge an error).
- **Real integrations over mocks** — Where feasible, exercise real Docker / real registries
  / real Kubernetes. Mocks are a last resort, not a default.
- **Add nothing speculative** — Features, abstractions, and config knobs land when a
  concrete need exists, not for hypothetical futures.

## Development Workflow & Quality Gates

Every change MUST pass the same gates CI enforces before it merges. Locally these are:

- **Formatting** — `prettier --check 'src/**'` (strict: no semicolons, single quotes, 120
  columns, 2-space indent, `es5` trailing commas). `npm run format` to fix.
- **Linting** — `eslint . --ext .ts`. `no-console` is an error; output MUST route through
  the `Environment` (`stdout`/`stderr`/`console`/`status`), never `console.*` in `src/`.
- **Typecheck / build** — `tsc -b tsconfig.json` (this also typechecks spec files).
- **Unit suite** — `CI=true npm test`. The `CI=true` flag matches CI; container/k8s suites
  gate themselves on their env flags and no-op when unset.
- **Integration suite** — `jest --config jest.integration.config.ts` exercises real
  Docker / registries / Kubernetes per Principle VIII and the Decision Heuristics.

Coverage MUST NOT regress. Code review MUST verify compliance with these principles, and
any added complexity MUST be justified (see the plan template's Complexity Tracking).

## Governance

This constitution supersedes ad-hoc practice. When guidance conflicts, the constitution
wins; deviations require explicit justification in the pull request.

**Amendments** MUST be proposed via pull request, recorded in the Sync Impact Report at the
top of this file, and version-bumped per the policy below. Material principle changes SHOULD
note migration impact for dependent templates and docs.

**Versioning policy** (for this constitution):

- **MAJOR** — Backward-incompatible governance or principle removal/redefinition.
- **MINOR** — A new principle or section, or materially expanded guidance.
- **PATCH** — Clarifications, wording, and non-semantic refinements.

**Compliance**: PRs and reviews MUST verify alignment with these principles. Unjustified
violations block merge.

**Runtime guidance**: `VALUES.md` is the canonical statement of intent and the source of
these principles. Day-to-day agent operating rules live in `AGENTS.md`; durable corrections
live in `.agents/FEEDBACK.md`. Read those for operational detail; this document governs.

**Version**: 1.0.0 | **Ratified**: 2026-05-30 | **Last Amended**: 2026-05-30
