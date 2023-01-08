export function splitName(name: string): { prefix?: string; name: string } {
  const index = name.indexOf(':')
  if (index > 0) {
    return { prefix: name.substr(0, index), name: name.substr(index + 1) }
  } else {
    return { name }
  }
}
