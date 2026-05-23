import { normalizePath } from './normalize-path'

describe('normalize-path', () => {
  it('should append src to cwd', () => {
    const result = normalizePath('/home/user/proj', '/home/user', 'src')
    expect(result).toEqual('/home/user/proj/src')
  })

  it('should append .kube to pwd', () => {
    const result = normalizePath('/home/user/proj', '/home/user', '$PWD/.kube')
    expect(result).toEqual('/home/user/.kube')
  })

  it('should append nothing to /usr/bin', () => {
    const result = normalizePath('/home/user/proj', '/home/user', '/usr/bin')
    expect(result).toEqual('/usr/bin')
  })
})
