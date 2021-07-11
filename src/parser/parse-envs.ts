export function parseEnvs(fileName: string, envs: unknown): { [key: string]: string } | null {
  if (!envs) {
    return null
  }

  if (typeof envs !== 'object') {
    throw new Error(`${fileName} envs need to be an object`)
  }

  const result: { [key: string]: string } = {}
  for (const [key, value] of Object.entries(envs || {})) {
    if (typeof value === 'string') {
      result[key] = value
    } else if (typeof value === 'number') {
      result[key] = value.toString()
    } else {
      throw new Error(`${fileName} envs ${key} need to be a string or number`)
    }
  }

  return result
}
