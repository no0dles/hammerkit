export interface ProcessItem {
  id: string
  started: Date
  promise: Promise<any>
  abortController: AbortController
}
