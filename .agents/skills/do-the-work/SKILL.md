---
name: do-the-work
description: >-
  Do the actual work instead of avoiding it, and don't make the user repeat
  feedback. Use whenever the task is to fix something — fix CI, fix a failing or
  flaky test, fix the build, make a check green, resolve a bug — or any time you
  are tempted to skip, disable, exclude, defer, or stop early. Read and apply the
  repo feedback log before working; append to it when corrected.
---

# Do the work (hammerkit)

The job is to **fix the thing**, not to find a way around fixing it. This skill
exists because avoidance kept showing up as the default reflex, and because the
user does not want to repeat feedback he has already given.

## The contract

When the task is to make something pass — CI, a test, the build, a check — the
deliverable is that it passes **because the underlying problem is fixed**. The
following are *never* the resolution (only do them if the user explicitly asks in
this conversation):

- `.skip` / `it.skip` / `describe.skip` / `xfail` / `test.todo`
- excluding files or paths from a suite, or commenting-out / deleting a test
- loosening or removing an assertion so it stops failing
- raising a timeout to a giant fixed value to paper over a hang
- declaring something "flaky locally" and moving on
- stopping early and handing back an unfixed failure as if it were done

Instead: diagnose the root cause (timing, environment, file-watching, resource
leaks, ordering, a real bug) and fix it so the check passes legitimately. If a
failure is genuinely container/k8s/infra-only and can't be reproduced on this
host, **say so explicitly** and rely on CI to confirm — that is honest reporting,
not skipping.

## Good questions vs. avoidance dressed as a question

- **Ask freely:** how to implement something, which design/approach to take,
  genuine ambiguity in the requirements, trade-offs that change the outcome. These
  are welcome.
- **Don't ask — just do it:** "Can I skip this test?", "Is it ok to leave this
  failing?", "Should I just remove/disable it?", "Want me to stop here?" If the
  effect of the question is to *avoid the assigned work*, the answer is already no
  — do the work.
- **Only escalate when truly blocked:** missing access/credentials, a product
  decision only the user can make, or contradictory requirements. Even then,
  propose the fix path, not the avoidance.

## Feedback discipline (don't make the user repeat himself)

The repo keeps a durable log at `.agents/FEEDBACK.md`.

1. **Read it before you start working** and apply every rule there.
2. **Don't re-ask anything it already answers.**
3. **When the user corrects you or states a preference, append an entry to it
   immediately** (rule + **Why** + **How to apply** + date), so it's never
   re-litigated.

## Canonical instance

"Never skip tests to go green" is the sharpest example of the contract — see the
`never skip tests` rule in `.agents/FEEDBACK.md`. The `fix-ci` and `before-commit`
skills are how you actually fix CI without skipping.
