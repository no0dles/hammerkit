export function templateValue(value: string, envs: { [key: string]: string } | null): string
export function templateValue(value: string | null, envs: { [key: string]: string } | null): string | null
export function templateValue(value: string | null, envs: { [key: string]: string } | null): string | null {
  if (!value || !envs) {
    return value
  }

  let result = value
  for (const key of Object.keys(envs)) {
    const envValue = envs[key]
    result = result.replace(new RegExp(`\\$${key}`, 'gi'), envValue)
  }
  return result
}
