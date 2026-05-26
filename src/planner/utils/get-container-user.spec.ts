jest.mock('os', () => ({ ...jest.requireActual('os'), platform: jest.fn() }))

import { platform } from 'os'
import { getContainerUser } from './get-container-user'

const mockedPlatform = platform as jest.MockedFunction<typeof platform>

describe('getContainerUser', () => {
  const originalGetuid = process.getuid
  const originalGetgid = process.getgid

  beforeEach(() => {
    Object.assign(process, { getuid: () => 1234, getgid: () => 4321 })
  })

  afterEach(() => {
    Object.assign(process, { getuid: originalGetuid, getgid: originalGetgid })
  })

  it.each(['linux', 'freebsd', 'openbsd', 'sunos'] as const)('returns uid:gid on %s', (p) => {
    mockedPlatform.mockReturnValue(p)
    expect(getContainerUser()).toBe('1234:4321')
  })

  it.each(['darwin', 'win32'] as const)('returns null on %s', (p) => {
    mockedPlatform.mockReturnValue(p)
    expect(getContainerUser()).toBeNull()
  })

  it('returns null on a unix platform when process.getuid is unavailable', () => {
    mockedPlatform.mockReturnValue('linux')
    ;(process as any).getuid = undefined
    expect(getContainerUser()).toBeNull()
  })
})
