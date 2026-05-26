export function getEnvironmentConfig(name: string, defaultValue: number): number {
  if (name in process.env) {
    // parseInt returns NaN (not nullish) when the value isn't a number, so use
    // an explicit NaN check; otherwise an invalid env value leaked NaN downstream.
    const parsed = parseInt(`${process.env[name]}`, 10)
    return Number.isNaN(parsed) ? defaultValue : parsed
  } else {
    return defaultValue
  }
}
