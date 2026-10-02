import { homedir } from 'os'
import { join } from 'path'
import { portablePath } from './portable-path'

describe('portablePath', () => {
  const root = join(homedir(), 'repos', 'app')

  it('makes a path inside the project root relative to it', () => {
    expect(portablePath(root, join(root, 'apps', 'web', 'dist'))).toBe('apps/web/dist')
  })

  it('maps the project root itself to "."', () => {
    expect(portablePath(root, root)).toBe('.')
  })

  it('makes a path in the home directory but outside the project home-relative', () => {
    expect(portablePath(root, join(homedir(), '.npm'))).toBe('~/.npm')
  })

  it('keeps a path outside both the project and home unchanged', () => {
    expect(portablePath('/workspace/app', '/var/run/docker.sock')).toBe('/var/run/docker.sock')
  })

  it('does not treat a sibling directory sharing a name prefix as inside the root', () => {
    expect(portablePath('/workspace/app', '/workspace/app-other/x')).toBe('/workspace/app-other/x')
  })
})
