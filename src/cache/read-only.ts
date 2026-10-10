export const CACHE_READ_ONLY_ENV = 'HAMMERKIT_CACHE_READ_ONLY'

// Read-only is on when the flag is passed or the env var is set to a truthy
// value, so a sandbox image can enforce it once for every invocation.
export function isCacheReadOnly(
  flag: boolean | undefined,
  processEnvs: { [key: string]: string | undefined }
): boolean {
  if (flag) {
    return true
  }
  const value = (processEnvs[CACHE_READ_ONLY_ENV] ?? '').trim().toLowerCase()
  return value !== '' && value !== '0' && value !== 'false' && value !== 'no'
}
