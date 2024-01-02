import { Readable } from 'stream'
import { ReadStream, WriteStream } from 'fs'

export interface FileContext {
  createDirectory(path: string): Promise<string>

  listFiles(path: string): Promise<string[]>

  stats(path: string): Promise<Stats>

  writeFile(path: string, content: string): Promise<void>
  writeStream(path: string, stream: Readable | NodeJS.ReadableStream): Promise<void>
  createWriteStream(path: string): WriteStream

  appendFile(path: string, content: string): Promise<void>

  read(path: string): Promise<string>
  readStream(path: string): ReadStream

  copy(source: string, destination: string): Promise<void>

  remove(path: string): Promise<void>

  exists(path: string): Promise<boolean>

  watch(path: string, callback: (fileName: string) => void): FileWatcher
}

export interface FileWatcher {
  close(): void
}

export interface FileStats {
  type: 'file'
  lastModified: number
}

export interface DirectoryStats {
  type: 'directory'
}

export interface OtherStats {
  type: 'other'
}

export type Stats = FileStats | DirectoryStats | OtherStats
