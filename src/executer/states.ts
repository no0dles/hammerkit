export function getDuration(started: Date): number {
  return new Date().getTime() - started.getTime()
}
