import { ConsoleContext } from './console-context'

export interface ConsoleContextMock extends ConsoleContext {
  expectLog(message: string): { fulfilled: boolean }
}
