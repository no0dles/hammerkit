---
description: >-
  Let a coding agent rewrite your existing CI pipeline into a hammerkit build
  file, following a guide written for it.
---

# Migrate your CI with a coding agent

Moving an existing pipeline to hammerkit is mostly mechanical: every CI job becomes
a task, every setup step becomes an image, every cache and artifact step goes away.
That makes it a good job for a coding agent (Claude Code, Cursor, Copilot, …).

The [CI migration guide](migrate-ci.md) is written for the agent, not for you: it
walks it through taking stock of your pipeline, writing the build file, rewriting
the CI config and proving the result runs the same checks as before.

## Hand it to your agent

Give your agent the repository and this prompt:

```
Migrate this repository's CI to hammerkit. Follow the guide at
https://raw.githubusercontent.com/no0dles/hammerkit/master/docs/llm/migrate-ci.md
step by step, including its verification and its final report.
```

If your agent can't read URLs, copy
[`docs/llm/migrate-ci.md`](https://github.com/no0dles/hammerkit/blob/master/docs/llm/migrate-ci.md)
into your repository and point it at the file instead.

You need [hammerkit](../installation.md) and a running Docker daemon where the agent
works, so it can run the build it writes.

## What you get back

* a `.hammerkit.yaml` (plus included files in a monorepo) with one task per build,
  lint and test step;
* your CI config rewritten to install hammerkit and run those tasks, keeping
  triggers, conditions, secrets and deployments where they were;
* `.hammerkit` added to `.gitignore`;
* a report: which job became which task, what was dropped and why, and what still
  needs you (secrets, registry permissions, deploy steps).

## Review it

Check the report first, then:

* **Same checks.** Every job of the old pipeline maps to a task or is listed as
  deliberately kept in CI.
* **Every input declared.** For each task, the files its commands read are in its
  `src` — see [what the cache can't see](../task/caching.md#limitations-what-the-cache-cant-see).
  This is where a migration can go wrong without anything failing.
* **Pinned toolchain.** Images carry the versions your CI used, ideally pinned by
  digest.
* **Runs twice.** `hammerkit run` twice in a row: the second run reports every task
  as cached.

Then try it on a branch and compare the run with the old pipeline before switching
over.
