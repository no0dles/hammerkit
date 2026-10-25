import { Environment } from '../executer/environment'
import { WorkScope } from '../executer/work-scope'
import { iterateWorkTasks } from '../planner/utils/plan-work-tasks'
import { parseReferences } from '../schema/reference-parser'
import { createParseContext } from '../schema/schema-parser'
import { getWorkContext } from '../schema/work-scope-parser'
import { SecretAccountDefinition, SecretCatalog, SecretProviderDefinition } from '../secrets/secret-catalog'
import { getErrorMessage } from '../log'
import { getCheckKey } from './check-key'

export interface CheckKeys {
  // by task name: the key, or why there is none
  [task: string]: { key: string } | { key: null; reason: string }
}

/**
 * The check keys of the tasks of a scope, as both ends compute them: the process of a run on
 * the server before it executes anything, and `remote verify` in a CI job's checkout. So the
 * build file is read the same way on both, as a server reads it (no `.env`, links are files)
 * but placed nowhere: where a server runs a task (a pool, its tool image, the arch of its
 * nodes) is the server's, and a result counts for the server it passed on. The secrets'
 * providers and accounts are the server's too, and no part of a key, so any is taken here.
 */
export async function getCheckKeys(entry: string, environment: Environment, scope: WorkScope): Promise<CheckKeys> {
  const keyed: Environment = { ...environment, hosted: { catalog: anyCatalog(), localTasksInContainers: true } }
  const { ctx, scope: parsed } = await createParseContext(entry, keyed)
  const workTree = getWorkContext(await parseReferences(ctx, parsed, keyed), scope, keyed)
  const memo = new Map<string, Promise<string | null>>()
  const keys: CheckKeys = {}
  for (const task of iterateWorkTasks(workTree)) {
    try {
      const key = await getCheckKey(task, keyed, memo)
      keys[task.name] = key
        ? { key }
        : { key: null, reason: 'it, or a task it depends on, declares no src that matches a file' }
    } catch (e) {
      // a secret whose value is part of the key (`cache: true`) is not known here
      keys[task.name] = { key: null, reason: getErrorMessage(e) }
    }
  }
  return keys
}

// Every provider and account name resolves, to a definition nothing runs.
function anyCatalog(): SecretCatalog {
  const provider = (name: string): SecretProviderDefinition => ({
    name,
    type: 'command',
    command: [],
    env: {},
    timeoutMs: 0,
    declaredIn: 'the server',
  })
  const account = (name: string): SecretAccountDefinition => ({
    name,
    default: false,
    providers: new Proxy({}, { get: () => ({ env: {} }) }),
    declaredIn: 'the server',
  })
  return {
    providers: new Proxy({}, { get: (_target, name) => (typeof name === 'string' ? provider(name) : undefined) }),
    accounts: new Proxy({}, { get: (_target, name) => (typeof name === 'string' ? account(name) : undefined) }),
    explicitAccounts: true,
  }
}
