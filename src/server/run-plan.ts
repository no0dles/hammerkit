import { Environment } from '../executer/environment'
import { LabelValues } from '../executer/label-values'
import { WorkScope } from '../executer/work-scope'
import { parseLabelArguments } from '../parser/parse-label-arguments'
import { Bundle } from '../remote/bundle'
import { getCredentialReads, InspectedBundle, planBundle, PlanPolicy } from './plan'
import type { RunOptions } from './run-request'

function labels(values: string[] | undefined): LabelValues | undefined {
  return values && values.length > 0 ? parseLabelArguments(values) : undefined
}

// The tasks in the order they were named, one scope each; by labels when none is.
// The arguments, if any, go to the one task named (the request allows no more). That
// task runs uncached unless the request names a `cache` method, as `run --cache` does.
export function getRunScopes(tasks: string[], options: RunOptions): { name: string; scope: WorkScope }[] {
  const args =
    options.args && options.args.length > 0
      ? { values: options.args, services: false, cache: options.cache !== undefined }
      : undefined
  return tasks.length > 0
    ? tasks.map((task) => ({
        name: task,
        scope: { taskName: task, environmentName: options.env ?? null, ...(args ? { args } : {}) },
      }))
    : [
        {
          name: 'labels',
          scope: {
            filterLabels: labels(options.filter),
            excludeLabels: labels(options.exclude),
            environmentName: options.env ?? null,
          },
        },
      ]
}

export interface PlannedRun {
  // the tasks and services the run executes, with their dependencies
  plan: InspectedBundle['plan']
  // the accounts they use
  accounts: string[]
}

/**
 * What a run will do, read with the engine from the files of the version it is
 * pinned to and with the environment a run has: the same function answers at
 * submit, and again in the executor, so what was approved is what runs.
 */
export async function planRun(
  bundle: Bundle,
  run: { tasks: string[]; options: RunOptions },
  environment: Environment,
  policy: PlanPolicy
): Promise<PlannedRun> {
  const plan: PlannedRun['plan'] = {}
  for (const { scope } of getRunScopes(run.tasks, run.options)) {
    Object.assign(plan, (await planBundle(bundle, environment, { scope, policy })).plan)
  }
  return {
    plan,
    accounts: [...new Set(Object.values(plan).flatMap((entry) => entry.accounts))].sort(),
  }
}

const readsOf = getCredentialReads

/**
 * Why a run may not pass its arguments, or null when it may. They go to a task, never a
 * service, and never to a run in which an item reads a secret or takes a variable of the
 * server into its `envs`: an argument can make the command print what the task holds,
 * and what its dependencies write into their outputs or its services serve, past the
 * masking of secrets. So a shell on a server runs with no account and no credential of
 * the server. Under `runs.args: declared` they go only to a task that says `args: true`,
 * so a task nobody meant to take them never does.
 */
export function refuseArguments(
  run: { tasks: string[]; options: RunOptions },
  plan: PlannedRun['plan'],
  policy: Pick<PlanPolicy, 'args'> = {}
): string | null {
  if (!run.options.args || run.options.args.length === 0) {
    return null
  }
  const [name] = run.tasks
  const entry = plan[name]
  // a service named as a task is planned as nothing
  if (!entry || entry.kind !== 'task') {
    return `${name} is not a task of this version`
  }
  // planning the run refuses it before, this keeps the check with the others
  if (entry.args === false) {
    return `${name} takes no arguments (args: false)`
  }
  if (policy.args === 'declared' && entry.args !== true) {
    return `${name} takes no arguments on this server: it takes them only for tasks that say args: true (runs.args: declared)`
  }
  const reads = readsOf(entry)
  if (reads.length > 0) {
    return `${name} reads ${reads.join(', ')}, it takes no arguments on a server: an argument could make it print them`
  }
  // what a dependency or a service of the run holds reaches the task through its outputs or
  // its answers, where an argument can print it in a form no mask knows (`rev token.txt`)
  for (const [other, item] of Object.entries(plan).sort(([a], [b]) => a.localeCompare(b))) {
    const held = (other === name ? [] : readsOf(item)).join(', ')
    if (held.length > 0) {
      return `${name} takes no arguments on a server: ${other} in its run reads ${held}, and an argument could make ${name} print what ${other} hands on`
    }
  }
  return null
}

// What build files are read with on a server: the environment of its runs and the
// policy a build file has to meet.
export interface PlanContext {
  environment: Environment
  policy: PlanPolicy
}
