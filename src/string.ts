export function splitBy(value: string, sep: string): [string, string] {
  const index = value.indexOf(sep)
  const prefix = value.substr(0, index)
  const suffix = value.substr(index + 1)
  return [prefix, suffix]
}
