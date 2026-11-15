import { isFinal, Run } from './runs'
import { RunRequest, runRequestSchema } from './run-request'

/**
 * A retry (`POST /v1/runs/<id>/retry`) is the request the run was started with, sent again by
 * who retries it: the same published build file, tasks or services, settings and arguments,
 * from the same source. A run from a branch runs the commit it ran: the server refuses the
 * retry once the branch moved on, so the accounts of a branch never run a commit that is no
 * longer on it. A run on a sandbox runs on the files the sandbox holds now, the work of its
 * owner, who alone may retry it.
 *
 * It names every task the run named, not only those that failed: the tasks that passed are
 * read from the cache, and a run that was stopped or rejected has no failed ones to tell.
 */
export function getRetryRequest(run: Run, owner: boolean): { request: RunRequest } | { error: string } {
  if (!isFinal(run.state)) {
    return { error: `${run.id} is ${run.state}, a run is retried once it is over` }
  }
  let source: RunRequest['source']
  if (run.source.type === 'ref') {
    source = { type: 'ref', repo: run.source.repo, ref: run.source.ref, commit: run.source.commit }
  } else if (run.source.type === 'sandbox') {
    // a sandbox is its owner's: nobody else may run from it
    if (!owner) {
      return { error: `${run.id} ran from a sandbox of its owner, only they may retry it` }
    }
    source = { type: 'sandbox', id: run.source.id, ...(run.source.check ? { check: true as const } : {}) }
  } else {
    return { error: `${run.id} ran from uploaded files, which a run is not retried from` }
  }
  const parsed = runRequestSchema.safeParse({
    definition: run.definition,
    tasks: run.tasks,
    source,
    options: run.options ?? {},
    ...(run.up
      ? {
          services: run.up.services,
          ttl: `${run.up.ttl}ms`,
          ...(run.up.sleepTtl ? { sleepTtl: `${run.up.sleepTtl}ms` } : {}),
          name: run.up.name,
          endpoints: run.up.endpoints.map(({ service, port }) => ({ service, port })),
        }
      : {}),
  })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { error: `${run.id} can not be started again: ${issue.path.join('.') || 'request'}: ${issue.message}` }
  }
  return { request: parsed.data }
}
