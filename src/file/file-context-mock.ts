import { FileContext } from './file-context'

export interface FileContextMock extends FileContext {
  clear(): Promise<void>
}
