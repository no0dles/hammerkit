export function getEnvironmentConfig(name: string, defaultValue: number): number {
  if (name in process.env) {
    return parseInt(`${process.env[name]}`, 0) ?? defaultValue
  } else {
    return defaultValue
  }
}
