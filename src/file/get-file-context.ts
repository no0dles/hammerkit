import { appendFile, copyFile, mkdir, readdir, readFile, rmdir, stat, writeFile } from 'fs'
import { dirname, join } from 'path'
import { watch } from 'chokidar'
import { FileContext, Stats } from './file-context'
import { Defer } from '../utils/defer'

function handleCallback<T>(defer: Defer<T>): (err: Error | null, value: T) => void
function handleCallback(defer: Defer<void>): (err: Error | null) => void
function handleCallback(defer: Defer<any>): (err: Error | null, value?: any) => void {
  return (err: Error | null, value: any) => {
    if (err) {
      defer.reject(err)
    } else {
      defer.resolve(value)
    }
  }
}

export function getFileContext(): FileContext {
  return {
    stats(path: string): Promise<Stats> {
      const defer = new Defer<{ type: 'file'; lastModified: number } | { type: 'directory' } | { type: 'other' }>()
      stat(path, (err, stats) => {
        if (err) {
          defer.reject(err)
        } else {
          if (stats.isDirectory()) {
            defer.resolve({ type: 'directory' })
          } else if (stats.isFile()) {
            defer.resolve({ type: 'file', lastModified: stats.mtimeMs })
          } else {
            defer.resolve({ type: 'other' })
          }
        }
      })
      return defer.promise
    },
    appendFile(path: string, content: string): Promise<void> {
      const defer = new Defer<void>()
      appendFile(path, content, handleCallback(defer))
      return defer.promise
    },
    writeFile(path: string, content: string): Promise<void> {
      const defer = new Defer<void>()
      writeFile(path, content, handleCallback(defer))
      return defer.promise
    },
    listFiles(path: string): Promise<string[]> {
      const defer = new Defer<string[]>()
      readdir(path, handleCallback(defer))
      return defer.promise
    },
    exists(path: string): Promise<boolean> {
      const defer = new Defer<boolean>()
      stat(path, (err) => {
        if (err) {
          defer.resolve(false)
        } else {
          defer.resolve(true)
        }
      })
      return defer.promise
    },
    read(path: string): Promise<string> {
      const defer = new Defer<string>()
      readFile(path, (err, content) => {
        if (err) {
          defer.reject(err)
        } else {
          defer.resolve(content.toString())
        }
      })
      return defer.promise
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

        const defer = new Defer<void>()
        copyFile(source, destination, handleCallback(defer))
        return defer.promise
      }
    },
    createDirectory(path: string): Promise<void> {
      const defer = new Defer<string | undefined>()
      mkdir(path, { recursive: true }, handleCallback(defer))
      return defer.promise.then()
    },
    remove(path: string): Promise<void> {
      const defer = new Defer<void>()
      rmdir(path, { recursive: true }, handleCallback(defer))
      return defer.promise
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
