export function parseStringArray(fileName: string, taskName: string, valueName: string, value: any): string[] | null {
  if (!value) {
    return null
  }
  if (value instanceof Array) {
    if (!value.every((v) => typeof v === 'string')) {
      throw new Error(`${fileName} task ${taskName} ${valueName} needs to be a string array`)
    }
    return value
  } else {
    throw new Error(`${fileName} task ${taskName} ${valueName} needs to be a string array`)
  }
}
