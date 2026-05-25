---
name: fix-ci
description: >-
  Iterate until CI is green on the current branch. Use when GitHub Actions is red, a push
  broke the build, or the user asks to "fix CI" / "get CI green". Loop: read the failing run
  via gh -> diagnose the root cause from the logs -> implement a fix -> verify locally with
  the before-commit skill -> commit -> push -> watch the run -> repeat on failure.
---

# Fix CI (hammerkit)

Drive CI to green on the current branch. This skill is the **loop around a fix**; for the
actual local checks, use the **`before-commit`** skill — do not re-run an ad-hoc checklist
here.

Repeat until the run is green:
**check status → diagnose → fix → verify (before-commit) → commit → push → watch → repeat.**

## Step 1 — Check CI status

```bash
git branch --show-current
gh run list --branch "$(git branch --show-current)" --limit 5
gh run view <run-id> --log-failed     # or: gh pr checks   (if a PR is open)
```

Identify the failing **job** and **step**, then read its log to pin the root cause. Use this
workflow → gate map only to decide which `before-commit` gate to re-run (the command details
live in `before-commit`, not here):

- `build` → prettier (strict over all of `src/`), eslint, tsc build.
- `test` → the jest unit matrix on **ubuntu, windows, macos** (+ a `macos-containers` job).
- `integration` / `macos-containers` → docker/k8s tests; need Docker/Kubernetes and usually
  **cannot** be reproduced locally.

## Step 2 — Implement a fix

Make the **smallest** change that addresses the identified root cause. Repo conventions are
enforced by `before-commit`'s gates, so don't restate them — just keep the change clean. For
OS-specific (e.g. windows-only) or container/k8s failures, note that the fix may only be
verifiable in CI, not on this host.

## Step 3 — Verify locally (use `before-commit`)

Run the **`before-commit` skill** to run the same gates CI enforces, then re-run the
specific failing case while iterating (e.g.
`node_modules/.bin/jest src/path/to/file.spec.ts -t "test name"`).

If the failure is container/k8s-only and can't be reproduced on this host, **say so
explicitly** and rely on CI to confirm — never claim a gate passed that you didn't run.

## Step 4 — Commit

Stage only the files relevant to the fix and commit with a clear `type(scope): summary`
message describing the CI problem fixed (matching the repo's git-log style, e.g.
`fix: ...`, `test(ci): ...`, `style: ...`).

## Step 5 — Push

Push the current branch to its remote. (Never force-push.)

## Step 6 — Wait for CI

Watch the run produced by the push to completion:

```bash
gh run watch <run-id> --exit-status     # resolve <run-id> from the just-pushed commit
```

Or poll `gh run list --branch <branch>` / `gh pr checks` until the run finishes.

## Step 7 — Loop on red

- **Green** → report success and stop.
- **Red** → go back to Step 1 with the new failing logs and repeat.

## Guardrails

- Cap attempts (~3–5). If the **same** failure recurs across iterations, stop and surface it.
- Treat infra/flake as not-your-bug: the `integration` workflow runs on a self-hosted runner,
  and the `macos-containers` job uses colima (flaky, slow). If a failure looks like infra,
  stop and tell the user rather than looping.
- Never force-push and never touch files unrelated to the fix.

## Quick reference (gh — unique to this skill)

```bash
gh run list --branch <branch> --limit 5     # latest runs for the branch
gh run view <run-id> --log-failed           # failing logs only
gh pr checks                                 # status when a PR is open
gh run watch <run-id> --exit-status          # block until done; non-zero on failure
```

For local verification commands, see the **`before-commit`** skill.
