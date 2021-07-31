export function failNever(message: string): never {
  throw new Error(message)
}
