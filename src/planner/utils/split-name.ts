export function splitName(name: string): { prefix?: string; taskName: string } {
  const index = name.indexOf(':')
  if (index > 0) {
    return { prefix: name.substr(0, index), taskName: name.substr(index + 1) }
  } else {
    return { taskName: name }
  }
}
