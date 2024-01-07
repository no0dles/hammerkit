import {
  appendFile,
  copyFile,
  createReadStream,
  createWriteStream,
  mkdir,
  readdir,
  readFile,
  ReadStream,
  rm,
  stat,
  writeFile,
  WriteStream,
} from 'fs'
import { dirname, join, isAbsolute } from 'path'
import { watch } from 'chokidar'
import { FileContext, Stats } from './file-context'
import { Stream } from 'stream'

function handleCallback<T>(
  callback: (cb: (err: Error | null, value: T | null | undefined) => void) => void
): Promise<T> {
  //function handleCallback(callback: (cb: (err: Error | null) => void) => void): Promise<void>
  //function handleCallback(callback: (cb: (err: Error | null, value?: any) => void) => void): Promise<any> {
  return new Promise<any>((resolve, reject) => {
    callback((err: Error | null, value: any) => {
      if (err) {
        reject(err)
      } else {
        resolve(value)
      }
    })
  })
}

function getAbsolutePath(cwd: string, path: string) {
  if (isAbsolute(path)) {
    return path
  } else {
    return join(cwd, path)
  }
}

export function getFileContext(cwd: string): FileContext {
  return {
    stats(path: string): Promise<Stats> {
      return new Promise<Stats>((resolve, reject) => {
        stat(getAbsolutePath(cwd, path), (err, stats) => {
          if (err) {
            reject(err)
          } else {
            if (stats.isDirectory()) {
              resolve({ type: 'directory' })
            } else if (stats.isFile()) {
              resolve({ type: 'file', lastModified: stats.mtimeMs })
            } else {
              resolve({ type: 'other' })
            }
          }
        })
      })
    },
    appendFile(path: string, content: string): Promise<void> {
      return handleCallback((cb) => appendFile(getAbsolutePath(cwd, path), content, cb))
    },
    writeFile(path: string, content: string): Promise<void> {
      return handleCallback((cb) => writeFile(getAbsolutePath(cwd, path), content, cb))
    },
    async writeStream(path: string, stream: Stream): Promise<void> {
      const writeStream = createWriteStream(path)
      await new Promise<void>((resolve, reject) => {
        stream
          .pipe(writeStream)
          .on('error', (err) => reject(err))
          .on('close', () => resolve())
      })
    },
    createWriteStream(path: string): WriteStream {
      return createWriteStream(path)
    },
    listFiles(path: string): Promise<string[]> {
      return handleCallback((cb) => readdir(getAbsolutePath(cwd, path), cb))
    },
    exists(path: string): Promise<boolean> {
      return handleCallback((cb) =>
        stat(getAbsolutePath(cwd, path), (err) => {
          if (err) {
            cb(null, false)
          } else {
            cb(null, true)
          }
        })
      )
    },
    readStream(path: string): ReadStream {
      return createReadStream(path)
    },
    read(path: string): Promise<string> {
      return handleCallback((cb) =>
        readFile(getAbsolutePath(cwd, path), (err, content) => {
          if (err) {
            cb(err, null)
          } else {
            cb(null, content.toString())
          }
        })
      )
    },
    async copy(source: string, destination: string): Promise<void> {
      const absoluteSource = getAbsolutePath(cwd, source)
      const absoluteDestination = getAbsolutePath(cwd, destination)

      const exists = await this.exists(absoluteSource)
      if (!exists) {
        return
      }

      const stats = await this.stats(absoluteSource)
      if (stats.type === 'directory') {
        await this.createDirectory(absoluteDestination)
        for (const child of await this.listFiles(absoluteSource)) {
          await this.copy(join(absoluteSource, child), join(absoluteDestination, child))
        }
      } else {
        const destinationDirectory = dirname(absoluteDestination)
        const existsDestinationDirectory = await this.exists(destinationDirectory)
        if (!existsDestinationDirectory) {
          await this.createDirectory(destinationDirectory)
        }

        return handleCallback((cb) => copyFile(absoluteSource, absoluteDestination, cb))
      }
    },
    createDirectory(path: string): Promise<string> {
      return handleCallback((cb) => mkdir(getAbsolutePath(cwd, path), { recursive: true }, cb))
    },
    async remove(path: string): Promise<void> {
      const absolutePath = getAbsolutePath(cwd, path)
      if (await this.exists(absolutePath)) {
        return handleCallback((cb) => rm(absolutePath, { recursive: true }, cb))
      }
    },
    watch(path: string, callback: (fileName: string) => void): { close(): void } {
      const watcher = watch(getAbsolutePath(cwd, path))
      watcher.on('add', (fileName) => {
        callback(fileName)
      })
      watcher.on('change', (fileName) => {
        callback(fileName)
      })
      watcher.on('unlink', (fileName) => {
        callback(fileName)
      })

      return {
        close() {
          return watcher.close()
        },
      }
    },
  }
}
