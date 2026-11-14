import { PassThrough } from 'stream'
import { readLines } from './read-lines'

function linesOf(chunks: (string | Buffer)[], maxChars: number): Promise<string[]> {
  const input = new PassThrough()
  const lines: string[] = []
  readLines(input, maxChars, (line) => lines.push(line))
  return new Promise((resolve) => {
    input.on('end', () => resolve(lines))
    for (const chunk of chunks) {
      input.write(chunk)
    }
    input.end()
  })
}

describe('readLines', () => {
  it('splits lines across chunks, without their line feeds', async () => {
    expect(await linesOf(['one\ntw', 'o\r\n', '\nlast'], 100)).toEqual(['one', 'two', '', 'last'])
  })

  it('keeps a character whose bytes come in two chunks', async () => {
    const bytes = Buffer.from('grüße\n')
    expect(await linesOf([bytes.subarray(0, 3), bytes.subarray(3)], 100)).toEqual(['grüße'])
  })

  it('cuts a line that is too long and goes on with the next', async () => {
    expect(await linesOf(['abcdef', 'ghij\nok\n', 'abcdefgh'], 4)).toEqual([
      'abcd … [cut at 4 characters]',
      'ok',
      'abcd … [cut at 4 characters]',
    ])
  })
})
