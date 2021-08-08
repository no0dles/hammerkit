import { FileContext } from './file-context'
import { join } from 'path'

export async function* iterateFiles(path: string, file: FileContext): AsyncGenerator<string> {
  const exists = await file.exists(path)
  if (!exists) {
    return
  }

  const stats = await file.stats(path)
  if (stats.type === 'file') {
    yield path
  } else if (stats.type === 'directory') {
    for (const entry of await file.listFiles(path)) {
      for await (const result of iterateFiles(join(path, entry), file)) {
        yield result
      }
    }
  }
}
