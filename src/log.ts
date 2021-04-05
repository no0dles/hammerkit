export function getLogs(chunk: Buffer | string) {
  return chunk
    .toString()
    .split(/\r?\n/)
    .filter((s) => !!s)
}
