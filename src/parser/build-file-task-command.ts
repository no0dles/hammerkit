export type BuildTaskCommand = string | { type: 'cmd'; cmd: string; path: string | null }
