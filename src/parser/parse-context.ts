export type ParseContext =
  | {
      fileName: string
      type: 'task' | 'service'
      name: string
    }
  | { fileName: string; type: 'buildfile' }

export function parseContextDescription(ctx: ParseContext): string {
  if (ctx.type === 'buildfile') {
    return `${ctx.fileName} ${ctx.type}`
  } else {
    return `${ctx.fileName} ${ctx.type} ${ctx.name}`
  }
}
