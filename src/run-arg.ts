import { Defer } from './defer'
import { CacheMethod } from './optimizer/cache-method'
import { stat, readdir, writeFile, readFile, rmdir, copyFile, mkdir, watch, appendFile } from 'fs'
import { join, dirname } from 'path'
import { EmitterHandler } from './emit'
import { WorkTree } from './planner/work-tree'
import { WorkNode } from './planner/work-node'
import { WorkNodeState } from './planner/work-node-status'

export interface ExecutionContext<TContext = Context> {
  workers: number
  noContainer: boolean
  cacheMethod: CacheMethod
  watch: boolean

  context: TContext
  events: EmitterHandler<{ workTree: WorkTree; oldState: WorkNodeState; newState: WorkNodeState; nodeId: string }>
  runningNodes: { [id: string]: WorkNode }
}

export interface Context {
  processEnvs: { [key: string]: string | undefined }
  cancelDefer: Defer<void>
  cwd: string
  file: FileContext
  console: ConsoleContext
}

export interface FileContext {
  createDirectory(path: string): Promise<string | undefined>

  listFiles(path: string): Promise<string[]>

  stats(path: string): Promise<{ type: 'file'; lastModified: number } | { type: 'directory' } | { type: 'other' }>

  writeFile(path: string, content: string): Promise<void>

  appendFile(path: string, content: string): Promise<void>

  read(path: string): Promise<string>

  copy(source: string, destination: string): Promise<void>

  remove(path: string): Promise<void>

  exists(path: string): Promise<boolean>

  watch(path: string, callback: (fileName: string) => void): { close(): void }
}

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

export function fileContext(): FileContext {
  return {
    stats(path: string): Promise<{ type: 'file'; lastModified: number } | { type: 'directory' } | { type: 'other' }> {
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
    createDirectory(path: string): Promise<string | undefined> {
      const defer = new Defer<string | undefined>()
      mkdir(path, { recursive: true }, handleCallback(defer))
      return defer.promise
    },
    remove(path: string): Promise<void> {
      const defer = new Defer<void>()
      rmdir(path, { recursive: true }, handleCallback(defer))
      return defer.promise
    },
    watch(path: string, callback: (fileName: string) => void): { close(): void } {
      const watcher = watch(path, { recursive: true, persistent: false }, (type, fileName) => {
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

export interface ConsoleContext {
  debug(message: string): void

  info(message: string): void

  error(message: string): void

  warn(message: string): void
}
