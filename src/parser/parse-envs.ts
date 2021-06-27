export function parseEnvs(fileName: string, envs: any): { [key: string]: string } | null {
  if (envs && typeof envs !== 'object') {
    throw new Error(`${fileName} envs need to be an object`)
  }

  if (!envs) {
    return null
  }

  const result: { [key: string]: string } = {}
  for (const key of Object.keys(envs || {})) {
    const value = envs[key]
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
