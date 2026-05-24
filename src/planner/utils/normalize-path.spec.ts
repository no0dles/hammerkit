import { normalizePath } from './normalize-path'
import { sep, posix } from 'path'

// normalizePath uses the platform-native path.join, so expectations must use
// the native separator too. Mirrors the helper in parse-work-mount.spec.ts.
function toNative(val: string): string {
  return val.split(posix.sep).join(sep)
}

describe('normalize-path', () => {
  it('should append src to cwd', () => {
    const result = normalizePath('/home/user/proj', '/home/user', 'src')
    expect(result).toEqual(toNative('/home/user/proj/src'))
  })

  it('should append .kube to pwd', () => {
    const result = normalizePath('/home/user/proj', '/home/user', '$PWD/.kube')
    expect(result).toEqual(toNative('/home/user/.kube'))
  })

  it('should append nothing to /usr/bin', () => {
    const result = normalizePath('/home/user/proj', '/home/user', '/usr/bin')
    expect(result).toEqual('/usr/bin')
  })
})
