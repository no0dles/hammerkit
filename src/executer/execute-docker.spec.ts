vi.mock('os', async () => ({ ...(await vi.importActual<typeof import('os')>('os')), platform: vi.fn() }))
vi.mock('path', async () => ({ ...(await vi.importActual<typeof import('path')>('path')), sep: '\\' }))

import type { Mock, MockedFunction } from 'vitest'
import { platform } from 'os'
import { Container } from 'dockerode'
import { convertToPosixPath, startContainer } from './execute-docker'

const mockedPlatform = platform as MockedFunction<typeof platform>

function makeStatus() {
  return { console: vi.fn(), write: vi.fn() } as any
}

function makeContainer(start: Mock): Container {
  return { start } as unknown as Container
}

describe('convertToPosixPath', () => {
  afterEach(() => {
    mockedPlatform.mockReset()
  })

  it('returns the path unchanged on linux', () => {
    mockedPlatform.mockReturnValue('linux')

    expect(convertToPosixPath('/usr/local/share')).toBe('/usr/local/share')
    expect(convertToPosixPath('C:\\Users\\test')).toBe('C:\\Users\\test')
  })

  it('converts drive letter paths to posix on win32', () => {
    mockedPlatform.mockReturnValue('win32')

    expect(convertToPosixPath('C:\\Users\\test\\project')).toBe('/C/Users/test/project')
  })

  it('roots non drive windows paths on win32', () => {
    mockedPlatform.mockReturnValue('win32')

    expect(convertToPosixPath('\\usr\\local\\bin')).toBe('/usr/local/bin')
  })
})

describe('startContainer', () => {
  it('resolves when the container starts', async () => {
    const status = makeStatus()
    const start = vi.fn().mockResolvedValue(undefined)

    await expect(startContainer(status, makeContainer(start))).resolves.toBeUndefined()

    expect(start).toHaveBeenCalledTimes(1)
    expect(status.write).not.toHaveBeenCalled()
  })

  it('rejects with the port allocated message', async () => {
    const start = vi
      .fn()
      .mockRejectedValue({ json: { message: 'Bind for 0.0.0.0:80 failed: port is already allocated' } })

    await expect(startContainer(makeStatus(), makeContainer(start))).rejects.toThrow(
      'Bind for 0.0.0.0:80 failed: port is already allocated'
    )
  })

  it('rejects with the docker error message for other failures', async () => {
    const start = vi.fn().mockRejectedValue({ json: { message: 'some other failure' } })

    await expect(startContainer(makeStatus(), makeContainer(start))).rejects.toThrow('some other failure')
  })

  it('rejects with the message of a raw json buffer', async () => {
    const start = vi.fn().mockRejectedValue({ json: Buffer.from('raw error') })

    await expect(startContainer(makeStatus(), makeContainer(start))).rejects.toThrow('raw error')
  })

  it('rejects with the original error for unexpected failures', async () => {
    const error = new Error('boom')
    const start = vi.fn().mockRejectedValue(error)

    await expect(startContainer(makeStatus(), makeContainer(start))).rejects.toBe(error)
  })
})
