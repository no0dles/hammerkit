export function mergeEnvironmentVariables(
  base: { [key: string]: string | number } | undefined | null,
  extension: { [key: string]: string | number } | undefined | null
): { [key: string]: string } {
  const result: { [key: string]: string } = {}
  for (const [key, value] of Object.entries(base || {})) {
    result[key] = `${value}`
  }

  if (!extension) {
    return result
  }

  for (const key of Object.keys(extension)) {
    const value = extension[key]
    if (!result[key] && value) {
      result[key] = `${value}`
    }
  }
  return result
}