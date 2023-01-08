import { platform } from 'os'

export function getContainerUser(): string | null {
  return platform() === 'linux' || platform() === 'freebsd' || platform() === 'openbsd' || platform() === 'sunos'
    ? `${process.getuid()}:${process.getgid()}`
    : null
}
