import { WorkEnvironmentVariables } from '../../environment/replace-env-variables'

export function templateValue(value: string, envs: WorkEnvironmentVariables): string
export function templateValue(value: string | null, envs: WorkEnvironmentVariables): string | null
export function templateValue(value: string | null, envs: WorkEnvironmentVariables): string | null {
  if (!value || !envs) {
    return value
  }

  let result = value
  for (const [key, envValue] of Object.entries(envs.variables)) {
    result = result.replace(new RegExp(`\\$${key}`, 'gi'), envValue)
  }
  return result
}
