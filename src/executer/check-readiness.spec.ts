import { checkReadiness } from './check-readiness'

vi.mock('./execute-docker', () => ({
  execCommand: vi.fn(),
}))

import { execCommand } from './execute-docker'
import { Environment } from './environment'
import { Container } from 'dockerode'
import { WorkHealthcheck } from '../planner/work-healthcheck'

const status = { write: vi.fn() } as any
const environment = {} as Environment
const container = {} as Container
const abort = new AbortController().signal
const healthCheck: WorkHealthcheck = {
  cmd: { cwd: '/w', cmd: 'curl -f http://x', parsed: { command: 'curl', args: ['-f', 'http://x'] } },
}

describe('checkReadiness', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('runs the parsed command with a 2000ms timeout', async () => {
    vi.mocked(execCommand).mockResolvedValue({ type: 'result', result: { ExitCode: 0 } } as any)
    await checkReadiness(status, healthCheck, environment, container, abort)

    expect(execCommand).toHaveBeenCalledWith(
      status,
      environment,
      container,
      undefined,
      ['curl', '-f', 'http://x'],
      null,
      2000,
      abort
    )
  })

  it('returns false on timeout', async () => {
    vi.mocked(execCommand).mockResolvedValue({ type: 'timeout' } as any)
    await expect(checkReadiness(status, healthCheck, environment, container, abort)).resolves.toBe(false)
  })

  it('returns false when canceled', async () => {
    vi.mocked(execCommand).mockResolvedValue({ type: 'canceled' } as any)
    await expect(checkReadiness(status, healthCheck, environment, container, abort)).resolves.toBe(false)
  })

  it('returns true and debug-writes on exit code 0', async () => {
    vi.mocked(execCommand).mockResolvedValue({ type: 'result', result: { ExitCode: 0 } } as any)
    await expect(checkReadiness(status, healthCheck, environment, container, abort)).resolves.toBe(true)
    expect(status.write).toHaveBeenCalledWith('debug', expect.stringContaining('succeeded'))
  })

  it('returns false and debug-writes the exit code on failure', async () => {
    vi.mocked(execCommand).mockResolvedValue({ type: 'result', result: { ExitCode: 1 } } as any)
    await expect(checkReadiness(status, healthCheck, environment, container, abort)).resolves.toBe(false)
    expect(status.write).toHaveBeenCalledWith('debug', expect.stringContaining('1'))
  })
})
