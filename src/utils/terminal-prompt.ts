import { createInterface } from 'readline'

export type Prompt = (question: string) => Promise<string | undefined>

/**
 * Asks the person at the terminal one question and answers the line they typed, or
 * undefined when the input ended or the signal stopped the command first (Ctrl-C).
 * The terminal stays in its own line mode, so Ctrl-C is a signal as anywhere else.
 */
export function terminalPrompt(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  signal: AbortSignal
): Prompt {
  return (question) =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve(undefined)
        return
      }
      const lines = createInterface({ input, output, terminal: false })
      let answer: string | undefined
      const stop = () => lines.close()
      signal.addEventListener('abort', stop, { once: true })
      lines.once('close', () => {
        signal.removeEventListener('abort', stop)
        if (answer === undefined) {
          // what was asked ends on a line of its own
          output.write('\n')
        }
        resolve(answer)
      })
      lines.question(question, (line) => {
        answer = line
        lines.close()
      })
    })
}

/**
 * The prompt of the CLI: only when somebody sits at a terminal to answer it, never in
 * CI, where a question would wait until the job times out.
 */
export function getTerminalPrompt(
  processEnvs: { [key: string]: string | undefined },
  signal: AbortSignal,
  stdio: {
    stdin: NodeJS.ReadableStream & { isTTY?: boolean }
    stdout: NodeJS.WritableStream & { isTTY?: boolean }
  } = process
): Prompt | undefined {
  if (!stdio.stdin.isTTY || !stdio.stdout.isTTY || isSet(processEnvs.CI)) {
    return undefined
  }
  return terminalPrompt(stdio.stdin, stdio.stdout, signal)
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false'
}

export function isYes(answer: string | undefined): boolean {
  return /^\s*y(es)?\s*$/i.test(answer ?? '')
}
