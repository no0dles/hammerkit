import { Environment } from '../executer/environment'
import { SecretProviderDefinition } from './secret-catalog'
import { createCommandSecretProvider } from './command-secret-provider'

// What the core knows of a provider (ADR 0008): the value for a reference. A
// provider that is not a command (a vendor SDK) is another factory, the way a
// cache backend is.
export interface SecretProvider {
  resolve(ref: string, environment: Environment): Promise<string>
}

// A provider read as one account: `account` is the environment that makes it
// act as that service account, never anything of the caller's own login.
export interface SecretProviderBinding {
  definition: SecretProviderDefinition
  account: { name: string; env: { [key: string]: string } }
}

export type SecretProviderFactory = (binding: SecretProviderBinding) => SecretProvider

const factories = new Map<string, SecretProviderFactory>()

export function registerSecretProvider(type: string, factory: SecretProviderFactory): void {
  factories.set(type, factory)
}

export function createSecretProvider(binding: SecretProviderBinding): SecretProvider {
  const factory = factories.get(binding.definition.type)
  if (!factory) {
    throw new Error(`unknown secret provider type: ${binding.definition.type}`)
  }
  return factory(binding)
}

registerSecretProvider('command', createCommandSecretProvider)
