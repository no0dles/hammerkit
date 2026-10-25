import { normalizeHostPath, normalizePath } from './normalize-path'
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

describe('normalizeHostPath', () => {
  it('takes ~, $HOME and $PWD for the home directory', () => {
    for (const path of ['~/.cache', '$HOME/.cache', '$PWD/.cache']) {
      expect(normalizeHostPath('/home/user/proj', '/home/user', path)).toEqual(toNative('/home/user/.cache'))
    }
    expect(normalizeHostPath('/home/user/proj', '/home/user', '~')).toEqual(toNative('/home/user'))
  })

  it('keeps a name that only starts like one in the project', () => {
    expect(normalizeHostPath('/home/user/proj', '/home/user', '~cache')).toEqual(toNative('/home/user/proj/~cache'))
    expect(normalizeHostPath('/home/user/proj', '/home/user', '$HOMEDIR/x')).toEqual(
      toNative('/home/user/proj/$HOMEDIR/x')
    )
    expect(normalizeHostPath('/home/user/proj', '/home/user', 'data')).toEqual(toNative('/home/user/proj/data'))
  })
})
