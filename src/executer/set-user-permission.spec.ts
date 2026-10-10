import { setUserPermission } from './set-user-permission'

vi.mock('./execute-docker', () => ({
  execCommand: vi.fn(),
}))

import { execCommand } from './execute-docker'
import { Environment } from './environment'
import { Container } from 'dockerode'

const status = { write: vi.fn() } as any
const environment = {} as Environment
const container = {} as Container

describe('setUserPermission', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('runs chown on / with the given user', async () => {
    vi.mocked(execCommand).mockResolvedValue({ type: 'result', result: { ExitCode: 0 } } as any)
    await setUserPermission('/data', status, environment, container, '1000:1000')

    expect(execCommand).toHaveBeenCalledWith(
      status,
      environment,
      container,
      '/',
      ['chown', '1000:1000', '/data'],
      null,
      undefined,
      expect.any(AbortSignal)
    )
    expect(status.write).not.toHaveBeenCalledWith('warn', 'unable to set permissions for /data')
  })

  it('returns silently when canceled', async () => {
    vi.mocked(execCommand).mockResolvedValue({ type: 'canceled' } as any)
    await setUserPermission('/data', status, environment, container, '1000:1000')
    expect(status.write).not.toHaveBeenCalledWith('warn', 'unable to set permissions for /data')
  })

  it('warns on timeout', async () => {
    vi.mocked(execCommand).mockResolvedValue({ type: 'timeout' } as any)
    await setUserPermission('/data', status, environment, container, '1000:1000')
    expect(status.write).toHaveBeenCalledWith('warn', 'unable to set permissions for /data')
  })

  it('warns when the exit code is non-zero', async () => {
    vi.mocked(execCommand).mockResolvedValue({ type: 'result', result: { ExitCode: 1 } } as any)
    await setUserPermission('/data', status, environment, container, '1000:1000')
    expect(status.write).toHaveBeenCalledWith('warn', 'unable to set permissions for /data')
  })
})
