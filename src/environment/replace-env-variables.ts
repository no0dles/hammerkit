import { Environment } from '../executer/environment'
import { ReferencedContext } from '../schema/reference-parser'

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

// `${NAME}` or `${NAME:-default}` anywhere in a value
const INTERPOLATION = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

// The shell / process environment first, then the .env files. A variable set to
// an empty string is set, as in a shell: CI providers leave many empty (a merge
// request id on a branch pipeline).
function resolveReference(name: string, environment: Environment, context: ReferencedContext): string | null {
  const processValue = environment.processEnvs[name]
  if (processValue !== undefined && processValue !== null) {
    return processValue
  }
  for (const envFile of Object.values(context.envFiles)) {
    const fileValue = envFile[name]
    if (fileValue !== undefined && fileValue !== null) {
      return fileValue
    }
  }
  return null
}

export function buildEnvironmentVariables(
  envs: { [key: string]: string },
  environment: Environment,
  context: ReferencedContext
): WorkEnvironmentVariables {
  const replacements: EnvironmentVariableReplacement[] = []
  const variables: { [key: string]: string } = {}
  for (const [key, value] of Object.entries(envs)) {
    if (value.startsWith('$') && !value.startsWith('${')) {
      const name = value.substring(1)
      const nameValue = resolveReference(name, environment, context)
      if (nameValue !== null) {
        replacements.push({ key, name, available: true, value: nameValue })
      } else {
        replacements.push({ key, name, available: false, value: null })
      }
    } else if (value.includes('${')) {
      const interpolated = interpolate(value, envs, environment, context)
      if (interpolated.missing) {
        replacements.push({ key, name: interpolated.missing, available: false, value: null })
      } else {
        variables[key] = interpolated.value
      }
    } else {
      variables[key] = value
    }
  }
  return { variables, replacements }
}

// Each `${NAME}` comes from the process environment or a .env file, else from a
// literal value of the same build file / task `envs`, else from its
// `:-default`. A reference without any of them is missing.
function interpolate(
  value: string,
  envs: { [key: string]: string },
  environment: Environment,
  context: ReferencedContext
): { value: string; missing: string | null } {
  let missing: string | null = null
  const result = value.replace(INTERPOLATION, (match: string, name: string, fallback: string | undefined) => {
    const resolved = resolveReference(name, environment, context) ?? getLiteral(envs, name) ?? fallback ?? null
    if (resolved === null) {
      missing = missing ?? name
      return match
    }
    return resolved
  })
  return { value: result, missing }
}

function getLiteral(envs: { [key: string]: string }, name: string): string | null {
  const literal = envs[name]
  if (literal === undefined || literal.includes('$')) {
    return null
  }
  return literal
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
