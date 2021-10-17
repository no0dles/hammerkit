import { ConsoleContext } from './console-context'

export interface ConsoleContextMock extends ConsoleContext {
  expectLog(message: string): { fulfilled: boolean }
  on(listener: ConsoleContextMockListener): void
}

export type ConsoleContextMockListener = (type: string, message: string) => void
