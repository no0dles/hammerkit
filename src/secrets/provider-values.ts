import { Environment } from '../executer/environment'
import { SecretProviderBinding, createSecretProvider } from './secret-provider'

interface FetchedValue {
  promise: Promise<string>
  // set once the fetch succeeded, for the synchronous read of a task id
  value?: string
}

// The values fetched in the current run, by provider, account and reference.
// Concurrent requests share one fetch: a secret manager is rate limited (a
// 1Password service account per token) and several tasks read the same value.
// Held in memory only, never written anywhere, and dropped when the next run
// begins so a rotated value is picked up by it.
const runs = new WeakMap<Environment, Map<string, FetchedValue>>()

export function beginSecretRun(environment: Environment): void {
  runs.set(environment, new Map())
}

function keyOf(binding: SecretProviderBinding, ref: string): string {
  return [binding.definition.name, binding.account.name, ref].join('\0')
}

export function fetchProviderValue(
  binding: SecretProviderBinding,
  ref: string,
  environment: Environment
): Promise<string> {
  let values = runs.get(environment)
  if (!values) {
    values = new Map()
    runs.set(environment, values)
  }
  const key = keyOf(binding, ref)
  let fetched = values.get(key)
  if (!fetched) {
    environment.status
      .context({ type: 'cli', name: 'hammerkit' })
      .write('debug', `secret ${ref} via ${binding.definition.name}/${binding.account.name}`)
    const entry: FetchedValue = { promise: createSecretProvider(binding).resolve(ref, environment) }
    entry.promise = entry.promise.then((value) => {
      entry.value = value
      return value
    })
    fetched = entry
    values.set(key, fetched)
  }
  return fetched.promise
}

// The value of a fetch that has finished in this run, for the sync part of
// planning (a task id); undefined when it was not fetched, see prefetchSecrets.
export function peekProviderValue(
  binding: SecretProviderBinding,
  ref: string,
  environment: Environment
): string | undefined {
  return runs.get(environment)?.get(keyOf(binding, ref))?.value
}
