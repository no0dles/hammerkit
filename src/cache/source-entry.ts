export interface SourceEntry {
  relativePath: string
  absolutePath: string
  ignore: SourceEntryFilterFn
}

export type SourceEntryFilterFn = (fileName: string) => boolean
