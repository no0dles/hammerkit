import { Environment } from '../executer/environment'

export interface WorkEnvironmentVariables {
  variables: { [key: string]: string }
  replacements: EnvironmentVariableReplacement[]
}

export type EnvironmentVariableReplacement =
  | {
      key: string
      name: string
      available: false
      value: null
    }
  | {
      key: string
      name: string
      available: true
      value: string
    }

export function buildEnvironmentVariables(
  envs: { [key: string]: string },
  environment: Environment
): WorkEnvironmentVariables {
  const replacements: EnvironmentVariableReplacement[] = []
  const variables: { [key: string]: string } = {}
  for (const [key, value] of Object.entries(envs)) {
    if (value.startsWith('$')) {
      const name = value.substring(1)
      const nameValue = environment.processEnvs[name] ?? null
      if (nameValue) {
        replacements.push({
          key,
          name,
          available: true,
          value: nameValue,
        })
      } else {
        replacements.push({
          key,
          name,
          available: false,
          value: null,
        })
      }
    } else {
      variables[key] = value
    }
  }
  return { variables, replacements }
}
export function getEnvironmentVariables(envs: WorkEnvironmentVariables): { [key: string]: string } {
  const result = { ...envs.variables }
  for (const replacement of envs.replacements) {
    if (!replacement.available) {
      throw new Error(`missing environment variable ${replacement.name}`)
    }
    result[replacement.key] = replacement.value
  }
  return result
}
