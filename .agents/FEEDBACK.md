# Feedback log

Durable record of corrections and preferences the user has given AI agents working
in this repo. The point of this file is that the user should **not have to repeat
himself**.

**Contract — every agent, every session:**

1. **Read this file before you start working.** Apply every rule here without being
   reminded.
2. **Don't re-ask anything already answered here.** If a rule covers the situation,
   follow it instead of asking.
3. **When the user corrects you or states a preference, append an entry here
   immediately** — same session, before moving on — so it is captured for next
   time. Keep entries short: a rule, **Why**, **How to apply**, and a date.

Related: the companion `do-the-work` skill explains the behavior; this file is the
running record.

---

## Rules

### Do the work — don't propose avoiding it _(2026-05-25)_

Skipping, disabling, excluding, `.skip` / `it.skip` / `xfail`, commenting-out,
deleting, loosening/weakening an assertion, or stopping early is **never** an
acceptable way to resolve a failing test or a red build. Fix the root cause.

- **Why:** The user asked for the thing to be *fixed*. Avoiding the work is not a
  smaller version of the job — it's not doing the job, and it hides a regression.
  Avoidance being the agent's default reflex is what the user finds worrying.
- **How to apply:** Diagnose the underlying cause (timing, environment,
  file-watching, resource leaks, ordering, a real bug) and fix it so the check
  passes legitimately. Only ever skip/disable something if the user *explicitly*
  asks for it in that conversation.

### "Fix CI" means fix the failure, not remove the test _(2026-05-25)_

When the task is to get CI green, the deliverable is a green run achieved by
fixing what is broken — not by removing, skipping, or muting the failing check.

- **Why:** Fixing CI *is* the requested work. Removing the test makes CI green
  while leaving the actual problem in place.
- **How to apply:** Use the `fix-ci` skill loop (diagnose → fix → verify →
  commit → push → watch). If a failure is genuinely container/k8s/infra-only and
  cannot be reproduced on this host, say so explicitly and rely on CI to confirm
  the fix — that is not the same as skipping the test.

### Prefer configurable timeouts over skips or huge fixed values _(2026-05-25)_

When a test hangs or flakes, make the timeout configurable (e.g. via env var)
rather than skipping the test or hardcoding a giant timeout.

- **Why:** CI is slower than local; a configurable budget lets local fail fast
  (surfacing hangs quickly) while CI gets the time it needs. Reducing flake is
  always desirable; skipping never is.
- **How to apply:** Drive the timeout from an env var with a sensible local
  default and a longer CI value; fix the underlying cause of the hang/flake.

### Ask implementation questions freely; never ask permission to avoid work _(2026-05-25)_

Questions about *how* to implement something — design, approach, ambiguity,
trade-offs — are welcome and encouraged. Questions that are really requests to
*not do* the assigned work are not.

- **Why:** The user repeatedly got asked variants of "can I skip/stop/disable
  this?" instead of getting the work done. He doesn't want to keep saying "no, do
  it."
- **How to apply:** If a question's effect is to avoid the work (skip a test,
  drop a requirement, leave the failure), don't ask it — do the work. Only
  escalate when *genuinely* blocked: missing access/credentials, a product
  decision only the user can make, or contradictory requirements — and even then,
  propose the fix path, not the avoidance.
