// Properties a build file may no longer have, with what takes their place: a file that
// still has one fails to parse with that, rather than with an unknown key.
export function assertNoRemovedProperties(input: unknown, fileName: string): void {
  const tasks = isObject(input) && isObject(input.tasks) ? input.tasks : {}
  for (const [name, task] of Object.entries(tasks)) {
    if (isObject(task) && 'continuous' in task) {
      throw new Error(
        `task ${name} in ${fileName}: continuous is for services only since hammerkit 2. A dev server that ` +
          `watches its own files (ng serve, vite, nodemon) is a service with continuous: true, see ` +
          `https://hammerkit.dev/docs/service/container#continuous`
      )
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
