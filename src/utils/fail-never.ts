export function failNever(value: never, message: string): never {
  throw new Error(message)
}
