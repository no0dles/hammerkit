import { Environment } from '../executer/environment'
import { LabelValues } from '../executer/label-values'
import { WorkScope } from '../executer/work-scope'
import { parseLabelArguments } from '../parser/parse-label-arguments'
import { Bundle } from '../remote/bundle'
import { InspectedBundle, planBundle, PlanPolicy } from './plan'
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

// Variables of a server that hold no credential (FR-008): a task may read these and
// still take arguments.
const PLAIN_SERVER_ENVS = ['PATH', 'HOME', 'CI']

/**
 * Why a run may not pass its arguments, or null when it may. They go to a task, never a
 * service, and never to a task that reads a secret or takes a variable of the server
 * into its `envs`: an argument can make the command print what it holds, so a shell on
 * a server holds no account and no credential of the server. Its dependencies and the
 * services it needs are not covered; publishers keep secrets out of their outputs.
 */
export function refuseArguments(
  run: { tasks: string[]; options: RunOptions },
  plan: PlannedRun['plan']
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
  const reads = [
    ...entry.secrets.map((secret) => `the secret ${secret.target}`),
    ...(entry.serverEnvs ?? [])
      .filter((env) => !PLAIN_SERVER_ENVS.includes(env.toUpperCase()))
      .map((env) => `$${env} of the server`),
  ]
  if (reads.length > 0) {
    return `${name} reads ${reads.join(', ')}, it takes no arguments on a server: an argument could make it print them`
  }
  return null
}

// What build files are read with on a server: the environment of its runs and the
// policy a build file has to meet.
export interface PlanContext {
  environment: Environment
  policy: PlanPolicy
}
