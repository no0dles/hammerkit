export type Process = (abort: AbortSignal, started: Date) => Promise<any>
