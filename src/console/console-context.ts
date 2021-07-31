export interface ConsoleContext {
  debug(message: string): void

  info(message: string): void

  error(message: string): void

  warn(message: string): void
}
