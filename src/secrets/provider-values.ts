import { Environment } from '../executer/environment'
import { SecretProviderBinding, createSecretProvider } from './secret-provider'

// The values fetched in the current run, by provider, account and reference.
// Concurrent requests share one fetch: a secret manager is rate limited (a
// 1Password service account per token) and several tasks read the same value.
// Held in memory only, never written anywhere, and dropped when the next run
// begins so a rotated value is picked up by it.
const runs = new WeakMap<Environment, Map<string, Promise<string>>>()

export function beginSecretRun(environment: Environment): void {
  runs.set(environment, new Map())
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
  const key = [binding.definition.name, binding.account.name, ref].join('\0')
  let value = values.get(key)
  if (!value) {
    environment.status
      .context({ type: 'cli', name: 'hammerkit' })
      .write('debug', `secret ${ref} via ${binding.definition.name}/${binding.account.name}`)
    value = createSecretProvider(binding).resolve(ref, environment)
    values.set(key, value)
  }
  return value
}
