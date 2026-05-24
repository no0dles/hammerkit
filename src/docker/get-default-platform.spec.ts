import { getDefaultPlatform } from './package'

describe('docker/getDefaultPlatform', () => {
  const realArch = process.arch

  function setArch(arch: string): void {
    Object.defineProperty(process, 'arch', { value: arch, configurable: true })
  }

  afterEach(() => {
    Object.defineProperty(process, 'arch', { value: realArch, configurable: true })
  })

  it('maps x64 to linux/amd64', () => {
    setArch('x64')
    expect(getDefaultPlatform()).toBe('linux/amd64')
  })

  it('maps arm64 to linux/arm64', () => {
    setArch('arm64')
    expect(getDefaultPlatform()).toBe('linux/arm64')
  })

  it('maps arm to linux/arm', () => {
    setArch('arm')
    expect(getDefaultPlatform()).toBe('linux/arm')
  })

  it('falls back to linux/amd64 for unknown architectures', () => {
    setArch('mips')
    expect(getDefaultPlatform()).toBe('linux/amd64')
  })
})
