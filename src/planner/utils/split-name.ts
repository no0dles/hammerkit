export function splitName(name: string): { prefix?: string; name: string } {
  const index = name.indexOf(':')
  if (index > 0) {
    return { prefix: name.substring(0, index), name: name.substring(index + 1) }
  } else {
    return { name }
  }
}
