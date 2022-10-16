import { ParseContext, parseContextDescription } from './parse-context'

export function parseEnvs(
  ctx: ParseContext,
  envs: unknown,
  baseEnvs: { [key: string]: string }
): { [key: string]: string } {
  if (!envs) {
    return baseEnvs
  }

  if (typeof envs !== 'object') {
    throw new Error(`${parseContextDescription(ctx)} envs need to be an object`)
  }

  const result: { [key: string]: string } = {
    ...baseEnvs,
  }
  for (const [key, value] of Object.entries(envs || {})) {
    if (typeof value === 'string') {
      result[key] = value
    } else if (typeof value === 'number') {
      result[key] = value.toString()
    } else {
      throw new Error(`${parseContextDescription(ctx)} envs ${key} need to be a string or number`)
    }
  }

  return result
}
