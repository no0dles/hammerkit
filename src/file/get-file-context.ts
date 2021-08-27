import { appendFile, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'fs'
import { dirname, join } from 'path'
import { watch } from 'chokidar'
import { FileContext, Stats } from './file-context'

function handleCallback<T>(callback: (cb: (err: Error | null, value: T | null | undefined) => void) => void): Promise<T>
function handleCallback(callback: (cb: (err: Error | null) => void) => void): Promise<void>
function handleCallback(callback: (cb: (err: Error | null, value?: any) => void) => void): Promise<any> {
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

export function getFileContext(): FileContext {
  return {
    stats(path: string): Promise<Stats> {
      return new Promise<Stats>((resolve, reject) => {
        stat(path, (err, stats) => {
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
      return handleCallback((cb) => appendFile(path, content, cb))
    },
    writeFile(path: string, content: string): Promise<void> {
      return handleCallback((cb) => writeFile(path, content, cb))
    },
    listFiles(path: string): Promise<string[]> {
      return handleCallback((cb) => readdir(path, cb))
    },
    exists(path: string): Promise<boolean> {
      return handleCallback((cb) =>
        stat(path, (err) => {
          if (err) {
            cb(null, false)
          } else {
            cb(null, true)
          }
        })
      )
    },
    read(path: string): Promise<string> {
      return handleCallback((cb) =>
        readFile(path, (err, content) => {
          if (err) {
            cb(err, null)
          } else {
            cb(null, content.toString())
          }
        })
      )
    },
    async copy(source: string, destination: string): Promise<void> {
      const exists = await this.exists(source)
      if (!exists) {
        return
      }

      const stats = await this.stats(source)
      if (stats.type === 'directory') {
        await this.createDirectory(destination)
        for (const child of await this.listFiles(source)) {
          await this.copy(join(source, child), join(destination, child))
        }
      } else {
        const destinationDirectory = dirname(destination)
        const existsDestinationDirectory = await this.exists(destinationDirectory)
        if (!existsDestinationDirectory) {
          await this.createDirectory(destinationDirectory)
        }

        return handleCallback((cb) => copyFile(source, destination, cb))
      }
    },
    createDirectory(path: string): Promise<string> {
      return handleCallback((cb) => mkdir(path, { recursive: true }, cb))
    },
    async remove(path: string): Promise<void> {
      if (await this.exists(path)) {
        return handleCallback((cb) => rm(path, { recursive: true }, cb))
      }
    },
    watch(path: string, callback: (fileName: string) => void): { close(): void } {
      const watcher = watch(path)
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
          watcher.close()
        },
      }
    },
  }
}
