import { WorkEnvironmentVariables } from '../../environment/replace-env-variables'

export function templateValue(value: string, envs: WorkEnvironmentVariables): string
export function templateValue(value: string | null, envs: WorkEnvironmentVariables): string | null
export function templateValue(value: string | null, envs: WorkEnvironmentVariables): string | null {
  if (!value || !envs) {
    return value
  }

  // A name is matched as the text it is, in any case; when two names match the same `$`, the
  // one listed first wins. One pass over the value: a value put in is not read again.
  const names = Object.keys(envs.variables).filter((name) => name.length > 0)
  if (names.length === 0) {
    return value
  }
  const values = new Map<string, string>()
  for (const name of names) {
    const key = name.toLowerCase()
    if (!values.has(key)) {
      values.set(key, envs.variables[name])
    }
  }
  const alternatives = names.map(escapeRegExp).join('|')
  const pattern = new RegExp(`\\$\\{(${alternatives})\\}|\\$(${alternatives})`, 'gi')
  return value.replace(pattern, (match, braced: string | undefined, bare: string | undefined) => {
    return values.get((braced ?? bare ?? '').toLowerCase()) ?? match
  })
}

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&')
}
